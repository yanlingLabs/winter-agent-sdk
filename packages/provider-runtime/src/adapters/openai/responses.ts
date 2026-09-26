// `openai-responses@1` — the OpenAI Responses API.
//
// Ported from Norma's `packages/core/src/providers/{openai-compatible.ts,responses-sse.ts}` and
// conformed to the Winter seam. The request shape's required-field set is Norma's LIVE-VERIFIED
// finding (2026-06-13 against the codex backend: `tools`, `tool_choice`, `parallel_tool_calls`,
// `store`, `include` are all required — omitting any of them is an HTTP 400), and it is carried over
// intact rather than re-derived from documentation — FOR THAT BACKEND. Since WS-23 (fix round 1, M2)
// the tool trio is omitted on a tool-less request everywhere else, where the public Responses API
// makes all three optional; `store` and `include` are still always sent. See `buildResponsesBody`.
//
// Three things this file does that the port did not, each because a Winter ruling requires it:
//
//   THE COMPLETED REASONING ITEM IS COLLECTED, THEN EMITTED ONCE. Norma emitted a `reasoning_item`
//     event per `response.output_item.done`. Winter's `native_state` is a WHOLE-TURN value the fold
//     takes "last one wins" from, so items are accumulated BY OUTPUT INDEX and emitted as a single
//     `native_state` at `response.completed` — in output order, which is the order §5.3 requires
//     them to be replayed in. `response.output_item.added` is never a source (its encrypted content
//     may be incomplete), and that is the brief's own hard rule.
//
//   TOOL ARGUMENTS STREAM. Norma ignored `response.function_call_arguments.delta` and used the final
//     item's `arguments`. Winter's fold accumulates deltas, so the deltas are forwarded — and the
//     final item is used ONLY when no delta was seen for that call, which is what keeps a provider
//     that sends the complete item and nothing else working identically.
//
//   AN UNREPRESENTABLE CALL IS AN ERROR. A `computer_call` / `mcp_call` / `custom_tool_call` arriving
//     in the output stream is a tool the model invoked that this adapter cannot express as a
//     `tool_call_*` triple. WS-13 §9 forbids dropping it silently, so it is a typed refusal.

import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { createHash } from "node:crypto";
import { parseSse } from "../../sse.ts";
import { isWinterBookkeepingItem } from "../../continuity/reasoning-blocks.ts";
import type { ContentBlockLike, CredentialRef, CredentialStatus, DiscoveryContext, ModelCatalogResult, ProviderAdapter, ProviderContext, ProviderEvent, ProviderMessageLike, TurnRequest } from "../../types.ts";
import {
  EventQueue,
  asBlocks,
  assertRepresentableTools,
  assertWithinLimits,
  buildHeaders,
  capabilitiesFrom,
  capabilityRefusal,
  errorEvent,
  fetchOpenAiModels,
  identityFor,
  imageDataUrl,
  isEncryptedContentRejection,
  makeRetryPolicy,
  mapEffortAgainst,
  openStream,
  parseSseJson,
  pumpEvents,
  resolveAuth,
  resolveEndpoint,
  resolveReasoning,
  decorationText,
  prefixToolResult,
  toolResultText,
  validateViaModels,
  type OpenAiAdapterOptions,
  type ReasoningPlan,
  type ResolvedEndpoint,
  normalizedPromptUsage,
} from "./shared.ts";

export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

/**
 * The adapter's compiled-in vendor endpoint, for THIS turn's provider — which is only ever OpenAI's.
 *
 * WS-23: `winter.openai-responses` serves more than one provider now (`openai`, `xai`), so
 * "the adapter's own default" stopped meaning "the provider's own endpoint". `api.openai.com` is
 * OpenAI's host; handing it to an `xai` connection with no `baseUrl` sent an xAI key to OpenAI,
 * silently, which is the no-silent-fallback rule broken at its most expensive. Every other provider
 * gets NO fallback: its endpoint comes from its own catalog row (`generatedBaseUrls`, wired by
 * `createShippedAdapters`) or its connection profile, and with neither the turn is refused typed.
 */
function vendorFallbackFor(ctx: ProviderContext): string | undefined {
  return ctx.connection.providerId === "openai" ? OPENAI_API_BASE_URL : undefined;
}

/**
 * The adapter's options for THIS turn's provider: OpenAI's account identifiers only for `openai`
 * (WS-23 fix round 1, M5).
 *
 * `organization`/`project` are construction options, so on an adapter shared by two vendors they
 * were one value for both: a host that configured them for OpenAI would send `OpenAI-Organization`
 * and `OpenAI-Project` — its OpenAI account topology — to `api.x.ai` on every xAI turn. The endpoint
 * gate (`applyPrivilegedHeaders`) cannot catch that, because xAI's endpoint is a REVIEWED one. Same
 * rule `xai-oauth.ts` applies by stripping them at construction; here it is per turn, because the
 * provider is only known per turn.
 */
function optionsForProvider(options: OpenAiAdapterOptions, ctx: ProviderContext): OpenAiAdapterOptions {
  if (ctx.connection.providerId === "openai") return options;
  const { organization: _organization, project: _project, ...rest } = options;
  return rest;
}

// --- request mapping --------------------------------------------------------------------------------

/**
 * `ProviderMessageLike[]` -> the Responses `input` array.
 *
 * The STRUCTURED content form is mandatory, and that is a live finding rather than a style choice:
 * the flat `{ role, content: "string" }` form was rejected with an HTTP 400 by the codex backend
 * (Norma, 2026-06-13). Assistant content is `output_text`, everything else `input_text`.
 *
 * NATIVE STATE LEADS ITS MESSAGE. §5.3 requires the provider's completed output items to be replayed
 * in their original order among messages and tool calls; a turn's real order is reasoning item(s)
 * first, then the message / function_call it produced. The renderer has already dropped any state
 * from a foreign continuation domain before this sees it, so what arrives here is replayable by
 * construction.
 */
export function mapResponsesInput(messages: readonly ProviderMessageLike[], opts: ResponsesInputOptions = {}): unknown[] {
  const out: unknown[] = [];
  const placement = opts.configurationUpdatePlacement ?? CONFIGURATION_UPDATE_PLACEMENT;
  // WS-23 (midconv): an update waiting for the user message it must follow ("after-user" only).
  let pendingUpdate: Record<string, unknown> | undefined;
  /** Appends one `configuration_update`, never next to another one ("the API rejects adjacent updates"). */
  const pushUpdate = (update: Record<string, unknown>): void => {
    const last = out[out.length - 1] as { type?: unknown } | undefined;
    // The later update wins: both would apply from the same point, so the earlier one says nothing. A
    // LOCAL decision (only the two items involved), so replaying the same history coalesces it the
    // same way and the input stays byte-stable from request to request.
    if (last?.type === "configuration_update") out[out.length - 1] = update;
    else out.push(update);
  };
  const search = opts.clientToolSearch === true ? toolSearchIndex(opts.tools) : undefined;
  // The ToolSearch calls seen so far, so their results become `tool_search_output` items.
  const searchCalls = new Set<string>();
  // Review I-2: each loaded tool's namespace AS THE HISTORY RECORDED IT (a search result's stored
  // definitions), built as the input is walked -- a call renders with the namespace its load gave it,
  // never with whatever the live tool list says now.
  const namespaceOf = new Map<string, string>();
  for (const message of messages) {
    // WS-23 (midconv): a tool-change message is an `additional_tools` developer item -- the tools
    // "become available only after that item appears in the input", so it is replayed right here.
    if (message.role === "system" && message.toolChanges !== undefined) {
      const definitions = message.toolChanges.add.flatMap((a) => (a.type === "definition" ? [{ type: "function", name: a.name, description: a.description, parameters: a.inputSchema, strict: false }] : []));
      if (definitions.length > 0) out.push({ type: "additional_tools", role: "developer", tools: definitions });
      continue;
    }
    // WS-23 (midconv): the engine's effort-only `system` marker IS a `configuration_update` on this
    // surface -- never a system message (see `CONFIGURATION_UPDATE_PLACEMENT`).
    if (message.role === "system" && message.outputConfig !== undefined) {
      const update = { type: "configuration_update", reasoning: { effort: message.outputConfig.effort } };
      if (placement === "after-user") pendingUpdate = update;
      else pushUpdate(update);
      if (typeof message.content === "string" ? message.content.length === 0 : message.content.length === 0) continue;
    }
    const outBefore = out.length;
    // WS-23 (reasoning-state, defect a): the turn's output layout, when it recorded one -- the reasoning
    // items then go back BETWEEN the turn's own items (below, after they are mapped), not ahead of them.
    const layout = message.role === "assistant" ? message.nativeState?.items.find(isResponsesLayoutItem) : undefined;
    // Replayed VERBATIM and never inspected: these are the provider's own completed items, and `items`
    // is `unknown[]` precisely so nothing here is tempted to look inside -- except to leave out Winter's
    // own bookkeeping (`winter.`-typed), which is never a vendor item.
    const vendorItems = message.role === "assistant" && message.nativeState !== undefined ? message.nativeState.items.filter((item) => !isWinterBookkeepingItem(item)) : [];
    if (layout === undefined) for (const item of vendorItems) out.push(item);
    const ownStart = out.length;
    // The Responses `input` has NO "tool" role — a tool result is a standalone
    // `function_call_output` item, and any residual text on such a message rides as a user message.
    // Emitting `role: "tool"` is a 400 (minor 4).
    const wireRole = message.role === "tool" ? "user" : message.role;
    const partType = wireRole === "assistant" ? "output_text" : "input_text";
    const blocks = asBlocks(message.content);
    const contentParts: unknown[] = [];
    // A Winter annotation LEADS its message, so the model reads it before the content it annotates —
    // EXCEPT on a message carrying tool results, where it prefixes the first result's own output
    // instead. A `message` item between a `function_call` and its `function_call_output` breaks the
    // pairing the surface requires (round 3), and an annotation that fails the turn is worse than
    // one that is dropped.
    const decoration = decorationText(message);
    const carriesToolResults = blocks.some((block) => block.type === "tool_result");
    if (decoration !== undefined && !carriesToolResults) contentParts.push({ type: partType, text: decoration });
    let resultPrefix = carriesToolResults ? decoration : undefined;
    for (const block of blocks) {
      switch (block.type) {
        case "text":
          if (block.text.length > 0) contentParts.push({ type: partType, text: block.text });
          break;
        case "image":
          // The Responses shape is `input_image` + `image_url` as a PLAIN data-URL string — not the
          // chat-completions `{ image_url: { url } }` object. Verified live by Norma's CU spike.
          contentParts.push({ type: "input_image", image_url: imageDataUrl(block) });
          break;
        case "tool_use":
          // Flushed before the call so the assistant's own text keeps its position ahead of it.
          if (contentParts.length > 0) {
            out.push({ type: "message", role: wireRole, content: [...contentParts] });
            contentParts.length = 0;
          }
          if (search !== undefined && block.name === search.name) {
            // WS-23 (midconv): Winter's ToolSearch call, replayed as the item the model emitted
            // (codex-rs's own round-trip fixture: `arguments` is an OBJECT here, not a JSON string).
            searchCalls.add(block.id);
            out.push({ type: "tool_search_call", call_id: block.id, execution: "client", status: "completed", arguments: block.input ?? {} });
            break;
          }
          {
            const namespace = search !== undefined ? namespaceOf.get(block.name) : undefined;
            out.push({
              type: "function_call",
              call_id: block.id,
              // A namespaced tool is called by its short name INSIDE its namespace (the vendor's
              // `{namespace, name}`), the way the model emitted it.
              name: namespace !== undefined ? block.name.slice(namespace.length + 2) : block.name,
              ...(namespace !== undefined ? { namespace } : {}),
              arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
            });
          }
          break;
        case "tool_result":
          // NO FLUSH HERE (Lane A r3 carry). Emitting the pending parts as a `message` first is what
          // the `tool_use` case above must do — the text precedes the call it introduces — but doing
          // it before an OUTPUT inserts an item between a `function_call` and the
          // `function_call_output` that answers it, which the surface rejects outright and the fake
          // now 400s. A message carrying `[tool_use, text, tool_result]` produced exactly that.
          //
          // The pending parts stay buffered and ride the trailing flush below, so they land AFTER
          // the outputs — the same trade the chat mapper already makes for trailing non-result
          // content ("nothing is inserted between a call and its reply"), and the same answer for a
          // host-supplied history that puts text ahead of a result on one message.
          if (search !== undefined && searchCalls.has(block.tool_use_id)) {
            // WS-23 (midconv): the ToolSearch result is a `tool_search_output` carrying the loaded tools'
            // definitions -- "Deferred functions in tool_search_output.tools retain defer_loading: true"
            // -- grouped by namespace. The loaded tools are "loaded at the end of the model's context
            // window", so `tools` never changes. Its own text (the listing, any MCP server still
            // connecting) follows as ordinary user text, like every trailing part of a tool message.
            const definitions = storedDefinitions(block);
            for (const d of definitions) if (d.namespace !== undefined) namespaceOf.set(d.name, d.namespace);
            out.push({ type: "tool_search_output", call_id: block.tool_use_id, execution: "client", status: "completed", tools: loadedToolsOutput(definitions) });
            const text = prefixToolResult(resultPrefix, toolResultText(block.content));
            if (text.length > 0) contentParts.push({ type: partType, text });
            resultPrefix = undefined;
            break;
          }
          out.push({ type: "function_call_output", call_id: block.tool_use_id, output: prefixToolResult(resultPrefix, toolResultText(block.content)) });
          // The FIRST result carries it; a message with several results annotates the set once.
          resultPrefix = undefined;
          break;
        default:
          // `thinking` / `redacted_thinking` / `tool_reference` are Anthropic-family or Winter-side
          // shapes with no Responses representation. They never originate here; across a family
          // switch Lane C's renderer strips them, and carrying a fabricated equivalent would be
          // exactly the impersonation R6-8 forbids.
          break;
      }
    }
    if (contentParts.length > 0) out.push({ type: "message", role: wireRole, content: contentParts });
    if (layout !== undefined) out.push(...interleaveWithLayout(vendorItems, out.splice(ownStart), layout));
    // "after-user": the waiting update lands right after the user message it was placed before --
    // Codex's position (the tail of `input`, behind the prompt). Only a HUMAN message counts, never a
    // tool output.
    if (pendingUpdate !== undefined && message.role === "user" && out.length > outBefore) {
      pushUpdate(pendingUpdate);
      pendingUpdate = undefined;
    }
  }
  if (pendingUpdate !== undefined) pushUpdate(pendingUpdate);
  return out;
}

/**
 * WS-23 (midconv): where a `configuration_update` goes relative to the user message it applies to.
 *
 * `"before-user"` is the DOCUMENTED placement: "place it before the next user message in the `input`
 * array" (https://developers.openai.com/api/docs/guides/reasoning, retrieved 2026-09-26) -- the same
 * slot the engine gives Anthropic's effort-only markers, so the engine lays out one list for both.
 * Codex does the opposite: it appends the item AFTER the user message, at the tail of `input`
 * (codex-rs `core/tests/suite/reasoning_effort_override.rs:458-488`, `core/src/session/turn.rs:509-511`).
 * Winter follows the docs; the live probe (`scripts/probe-openai-midconv.ts`) sends both and this one
 * constant is what flips if the endpoints disagree with their own page.
 */
export const CONFIGURATION_UPDATE_PLACEMENT: "before-user" | "after-user" = "before-user";

/** WS-23 (midconv): request-mapping knobs the probe script (and tests) can override. */
export interface ResponsesInputOptions {
  /** Defaults to `CONFIGURATION_UPDATE_PLACEMENT`. */
  configurationUpdatePlacement?: "before-user" | "after-user";
  /** The row documents client tool search: ToolSearch calls and results take the native items (needs `tools`). */
  clientToolSearch?: boolean;
  /** The request's tools -- where the ToolSearch name, the namespaces and the loaded definitions come from. */
  tools?: TurnRequest["tools"];
}

/**
 * WS-23 (midconv): the per-message effort gate for this surface. A `system` marker carrying
 * `outputConfig` is sent as a `configuration_update` only where the row's own
 * `reasoning.perMessageEffort` evidence names that item, and only at a level from the row's own
 * `reasoning.efforts`; anything else is refused before the request -- a model without the item (GPT-5.6,
 * any non-OpenAI row) would 400 upstream (a proxy's answer: "Invalid value: 'configuration_update'",
 * github.com/can1357/oh-my-pi/issues/11121). The engine only emits a marker for a row with the evidence,
 * so this fires on a wiring bug, never on an ordinary session.
 */
export function assertConfigurationUpdates(req: TurnRequest, descriptor: WinterModelDescriptor | undefined): void {
  for (const message of req.messages) {
    if (message.role !== "system" || message.outputConfig === undefined) continue;
    const mechanism = descriptor?.reasoning?.perMessageEffort?.value;
    if (mechanism === undefined || !("item" in mechanism) || mechanism.item !== "configuration_update") {
      throw capabilityRefusal(`model "${descriptor?.key ?? req.model}" does not document the Responses \`configuration_update\` item (no \`reasoning.perMessageEffort: {item: "configuration_update"}\` evidence), so a mid-conversation effort change is refused before the request rather than sent and rejected upstream`);
    }
    const efforts = descriptor?.reasoning?.efforts ?? [];
    if (!efforts.includes(message.outputConfig.effort)) {
      throw capabilityRefusal(`per-message effort "${message.outputConfig.effort}" is not in model "${descriptor?.key ?? req.model}"'s verified vocabulary (${efforts.join(", ")})`);
    }
  }
}

export function mapResponsesTools(tools: TurnRequest["tools"], opts: { clientToolSearch?: boolean } = {}): unknown[] {
  if (opts.clientToolSearch !== true) return (tools ?? []).map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false }));
  // WS-23 (midconv): client tool search. ToolSearch is the native tool; a deferred tool is NOT declared
  // -- it reaches the model only in a `tool_search_output`, the vendor's own client-search shape (codex-rs
  // declares none either), so loading one never changes `tools`.
  return (tools ?? [])
    .filter((tool) => tool.deferLoading !== true)
    .map((tool) =>
      tool.toolSearch === true
        ? { type: "tool_search", execution: "client", description: tool.description, parameters: tool.inputSchema }
        : { type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false },
    );
}

/**
 * WS-23 (midconv): what the client tool search needs to know about THIS request's tools -- ToolSearch's
 * name, each namespaced tool's namespace, and how to render the loaded tools of one search.
 */
interface ToolSearchIndex {
  name: string;
}

function toolSearchIndex(tools: TurnRequest["tools"]): ToolSearchIndex | undefined {
  const search = (tools ?? []).find((t) => t.toolSearch === true);
  return search === undefined ? undefined : { name: search.name };
}

/** One loaded tool's definition as the engine stored it at load time (`tool_result.loadedToolDefinitions`). */
interface StoredDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  namespace?: string;
}

/**
 * Review I-2: the definitions a ToolSearch result STORED when it loaded its tools. The history is replayed
 * from these and nothing else, so a server that disconnected since, or a tool whose description changed,
 * leaves every earlier `tool_search_output` byte-identical (rewriting one would bust the cache from there,
 * and misstate what the model was shown). A result with none renders an empty output.
 */
function storedDefinitions(block: ContentBlockLike): StoredDefinition[] {
  const raw = (block as { loadedToolDefinitions?: unknown }).loadedToolDefinitions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((d) => {
    if (d === null || typeof d !== "object") return [];
    const { name, description, inputSchema, namespace } = d as Record<string, unknown>;
    if (typeof name !== "string" || typeof description !== "string" || inputSchema === null || typeof inputSchema !== "object") return [];
    return [{ name, description, inputSchema: inputSchema as Record<string, unknown>, ...(typeof namespace === "string" && name.startsWith(`${namespace}__`) ? { namespace } : {}) }];
  });
}

/** A `tool_search_output`'s `tools`: the loaded definitions, `defer_loading` kept, MCP tools grouped in their namespace. */
function loadedToolsOutput(definitions: readonly StoredDefinition[]): unknown[] {
  const out: unknown[] = [];
  const groups = new Map<string, unknown[]>();
  const seen = new Set<string>();
  for (const d of definitions) {
    if (seen.has(d.name)) continue;
    seen.add(d.name);
    const fn = { type: "function", name: d.namespace !== undefined ? d.name.slice(d.namespace.length + 2) : d.name, description: d.description, parameters: d.inputSchema, strict: false, defer_loading: true };
    if (d.namespace === undefined) {
      out.push(fn);
      continue;
    }
    let group = groups.get(d.namespace);
    if (group === undefined) {
      group = [];
      groups.set(d.namespace, group);
      out.push({ type: "namespace", name: d.namespace, description: namespaceDescription(d.namespace), tools: group });
    }
    group.push(fn);
  }
  return out;
}

/** A namespace's description, which the shape requires: Winter's own words, deterministic per server. */
function namespaceDescription(namespace: string): string {
  return `Tools from the MCP server "${namespace.slice("mcp__".length)}".`;
}

/**
 * WS-23 (midconv): `tool_choice: allowed_tools` for a request whose callable set is a strict subset of
 * `tools` -- the engine's `allowedTools`, or `undefined` when it cannot be expressed (below; the caller then
 * sends the ordinary choice). A FORCED choice (the classifier, structured output) outranks it: the model
 * must call that one tool either way.
 *
 * ONLY FUNCTION ENTRIES, AND ONLY FUNCTIONS `tools` DECLARES (live L1, then the fix-round-3 live probe).
 * The API and the Codex backend refused a `{"type": "tool_search"}` entry ("Supported values are:
 * 'file_search', ... 'function', 'mcp', ... 'custom', 'apply_patch'" -- no `namespace` either), and then
 * refused a function a search had loaded into a namespace: `{"type": "function", "name": "lookup_order"}`
 * -> 400 "Tool choice 'lookup_order' not found in 'tools' parameter." (param `tool_choice`). A
 * search-loaded tool is never in `tools` (it arrives in a `tool_search_output`), and neither the
 * function-calling nor the tool-search guide shows any way to name one there. So when a search has
 * loaded ANY tool, this request sends NO `allowed_tools` at all (`undefined`): restricting the declared
 * functions would also withdraw the loaded ones. The engine's own permission layer still enforces the
 * live mode at dispatch; only the restriction's cache-friendly form is lost for such a session.
 */
function allowedToolsChoice(req: TurnRequest): unknown {
  // Only names `tools` declares AS FUNCTIONS: ToolSearch is the native `tool_search` (unlisted), and a
  // deferred tool is not declared at all.
  const declared = new Map((req.tools ?? []).map((t) => [t.name, t] as const));
  for (const message of req.messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      const loaded = (block as { loadedTools?: unknown }).loadedTools;
      if (storedDefinitions(block).length > 0 || (Array.isArray(loaded) && loaded.length > 0)) return undefined;
    }
  }
  const functions = (req.allowedTools ?? []).filter((name) => {
    const tool = declared.get(name);
    return tool !== undefined && tool.deferLoading !== true && tool.toolSearch !== true;
  });
  return { type: "allowed_tools", mode: req.toolChoice?.type === "any" ? "required" : "auto", tools: [...new Set(functions)].map((name) => ({ type: "function", name })) };
}

/**
 * WS-23 (midconv): the gate for the three mid-conversation tool mechanisms on this surface. Each is sent
 * only where the row's evidence documents it; anything else is refused before the request. The engine only
 * builds what a row can take, so this fires on a wiring bug, never on an ordinary session.
 */
export function assertResponsesToolFeatures(req: TurnRequest, descriptor: WinterModelDescriptor | undefined): void {
  const key = descriptor?.key ?? req.model;
  const searchShaped = (req.tools ?? []).some((t) => t.deferLoading === true || t.toolSearch === true || t.namespace !== undefined);
  if (searchShaped && descriptor?.clientToolSearch?.value !== true) {
    throw capabilityRefusal(`model "${key}" does not document OpenAI's client tool search (no \`clientToolSearch\` evidence), so a deferred or tool-search tool is refused before the request rather than sent and rejected upstream`);
  }
  for (const message of req.messages) {
    if (message.toolChanges === undefined) continue;
    if (descriptor?.additionalToolsItem?.value !== true) {
      throw capabilityRefusal(`model "${key}" does not document the \`additional_tools\` item (no \`additionalToolsItem\` evidence), so a mid-conversation tool addition is refused before the request`);
    }
    if (message.toolChanges.remove.length > 0 || message.toolChanges.add.some((a) => a.type !== "definition")) {
      throw capabilityRefusal("the Responses API adds tools mid-conversation by definition only; a withdrawal is an `allowed_tools` restriction, never a removal item");
    }
  }
  if (req.allowedTools !== undefined && descriptor?.allowedToolsChoice?.value !== true) {
    throw capabilityRefusal(`model "${key}" does not document \`tool_choice: allowed_tools\` (no \`allowedToolsChoice\` evidence), so a restricted callable set is refused before the request`);
  }
}

function mapToolChoice(choice: TurnRequest["toolChoice"]): unknown {
  if (choice === undefined) return "auto";
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  return { type: "function", name: choice.name };
}

/**
 * The Responses request body.
 *
 * `instructions` is sent ONLY when the caller supplied a non-empty system prompt — a deliberate
 * deviation from the port, which sent a default string. Global Constraints forbid vendor prompt
 * text, and inventing a Winter one would put an instruction in front of the model that no caller
 * asked for; codex-rs itself skips the field when it is empty.
 *
 * THE TOOL TRIO (`tools`, `tool_choice`, `parallel_tool_calls`) IS OMITTED WHEN THE REQUEST HAS NO
 * TOOLS (WS-23 fix round 1, M2) — all three are optional on the public Responses API (OpenAI's and
 * xAI's reference alike), and a model that takes no client tools (xAI's multi-agent row) should not
 * be sent an empty tool surface it never documented accepting. The ONE exception is the codex
 * backend, where the trio is REQUIRED: omitting any of them was an HTTP 400 (Norma's live finding,
 * 2026-06-13, this file's header). `codex-oauth.ts` passes `requireToolFields: true`; nothing else
 * does.
 */
export function buildResponsesBody(
  req: TurnRequest,
  reasoning: ReasoningPlan,
  descriptor: WinterModelDescriptor | undefined,
  opts: { requireToolFields?: boolean } & ResponsesInputOptions = {},
): Record<string, unknown> {
  const reasoningObject =
    reasoning.enabled && (reasoning.effort !== undefined || reasoning.summary !== undefined)
      ? { ...(reasoning.effort !== undefined ? { effort: reasoning.effort } : {}), ...(reasoning.summary !== undefined ? { summary: reasoning.summary } : {}) }
      : undefined;
  const sendToolFields = opts.requireToolFields === true || (req.tools?.length ?? 0) > 0;
  // WS-23 (midconv): the row's client tool search, when this request carries the tool that uses it.
  const clientToolSearch = descriptor?.clientToolSearch?.value === true && (req.tools ?? []).some((t) => t.toolSearch === true);
  // A forced choice outranks a restriction (see `allowedToolsChoice`).
  const toolChoice = (req.allowedTools !== undefined && req.toolChoice?.type !== "tool" ? allowedToolsChoice(req) : undefined) ?? mapToolChoice(req.toolChoice);
  return {
    model: req.model,
    ...(req.system !== undefined && req.system.length > 0 ? { instructions: req.system } : {}),
    input: mapResponsesInput(req.messages, {
      ...(opts.configurationUpdatePlacement !== undefined ? { configurationUpdatePlacement: opts.configurationUpdatePlacement } : {}),
      ...(clientToolSearch ? { clientToolSearch: true, tools: req.tools } : {}),
    }),
    ...(sendToolFields
      ? {
          tools: mapResponsesTools(req.tools, { clientToolSearch }),
          tool_choice: toolChoice,
          parallel_tool_calls: descriptor?.parallelTools?.value === false ? false : true,
        }
      : {}),
    store: false,
    stream: true,
    include: reasoning.wantsEncryptedContent ? ["reasoning.encrypted_content"] : [],
    ...(reasoningObject !== undefined ? { reasoning: reasoningObject } : {}),
    ...(req.maxOutputTokens !== undefined ? { max_output_tokens: req.maxOutputTokens } : {}),
    // WS-23: one conversation's requests share a cache-routing key, where the row documents the field
    // ("Use a stable `prompt_cache_key` to optimize cache routing for requests that share a reusable
    // prefix", https://developers.openai.com/api/docs/guides/prompt-caching). The Codex backend takes
    // it too -- the vendor's own client sets it to the session id on every request. `store: false`
    // above is unchanged: this routes to a warm cache, it keeps nothing server-side.
    ...(req.cacheKey !== undefined && descriptor?.promptCacheKey?.value === true ? { prompt_cache_key: req.cacheKey } : {}),
  };
}

// --- stream mapping -----------------------------------------------------------------------------------

/** Output item types that are a TOOL INVOCATION this adapter cannot express. Seeing one is an error, never a skip (WS-13 §9). */
function isUnrepresentableCall(itemType: string): boolean {
  return itemType !== "function_call" && (itemType.endsWith("_call") || itemType === "custom_tool_call");
}

/**
 * WS-23 (midconv): how this request's tools come back from the stream -- the ToolSearch tool's name, for a
 * CLIENT `tool_search_call` (the one `*_call` item this adapter can express: it is Winter's own ToolSearch,
 * run by Winter), and each namespaced tool's full Winter name by `namespace` + short name. Built from the
 * request's tools, never by concatenating the two parts.
 */
export interface ResponsesStreamTools {
  toolSearchName?: string;
  namespaced?: ReadonlyMap<string, string>;
}

/** The stream-side tool facts for a request (see `ResponsesStreamTools`). */
export function responsesStreamTools(req: TurnRequest, descriptor: WinterModelDescriptor | undefined): ResponsesStreamTools {
  if (descriptor?.clientToolSearch?.value !== true) return {};
  const search = (req.tools ?? []).find((t) => t.toolSearch === true);
  const namespaced = new Map((req.tools ?? []).flatMap((t) => (t.namespace !== undefined ? [[namespacedKey(t.namespace, t.name.slice(t.namespace.length + 2)), t.name] as const] : [])));
  // Plus every namespaced tool a search in the history LOADED (its stored definition): the model may call
  // one it already has in context even if the live list no longer groups it the same way.
  for (const message of req.messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      for (const d of storedDefinitions(block)) if (d.namespace !== undefined) namespaced.set(namespacedKey(d.namespace, d.name.slice(d.namespace.length + 2)), d.name);
    }
  }
  return { ...(search !== undefined ? { toolSearchName: search.name } : {}), ...(namespaced.size > 0 ? { namespaced } : {}) };
}

function namespacedKey(namespace: string, name: string): string {
  return `${namespace}\u0000${name}`;
}

/**
 * Responses SSE frames -> Winter's normalized `ProviderEvent`s.
 *
 * One instance per turn: the reasoning-item accumulator, the seen-a-call flag and the
 * did-this-call-stream-its-arguments map are all per-turn state.
 */
/**
 * Which stream event this family treats as COMPLETING, from the descriptor's own `completionEvent`
 * evidence (review round 1, C — ledger line 36).
 *
 * Lane B's pattern, applied here: `anthropicCaptureEvent` and the Google resolver both read this
 * field, and this family hard-coded `"response.completed"` — so a catalog row that DECLARED a
 * different terminator was silently ignored, and the evidence existed for two families out of four.
 *
 * MATCHED LENIENTLY BY MENTION, for the same reason those two are: the field is a prose-ish
 * `CapabilityEvidence<string>`, not an enum. `"response.completed"` stays as the fallback and is the
 * conservative answer — the pinned terminator for this surface, and the one every unlisted row means.
 *
 * `response.incomplete` is always ALSO treated as terminal and is deliberately not configurable: it
 * is a truncation, not a completion, and a row that named some other event would still have to end
 * its stream somewhere.
 */
export function responsesCompletionEvent(descriptor: WinterModelDescriptor | undefined): string {
  const declared = descriptor?.reasoning?.completionEvent?.value;
  return typeof declared === "string" && declared.trim().length > 0 ? declared.trim() : "response.completed";
}

/**
 * WS-23 (reasoning-state, defect a): where a turn's reasoning items sat AMONG its other output items.
 *
 * A Responses turn's output is an ordered list -- `[reasoning, message, reasoning, function_call]` on a
 * multi-agent xAI row, `[reasoning, function_call, reasoning, function_call]` on an interleaved tool
 * loop -- and the vendor asks for "the provider's completed output items ... in their original order".
 * The engine keeps a turn as text plus calls, so the reasoning items used to be replayed all together
 * AHEAD of the turn: `[r, m, r]` went back as `[r, r, m]`, the leading suspect for xAI's intermittent
 * "Could not decrypt the provided encrypted_content" on multi-agent replays. This item records the order
 * -- `{r: k}` the k-th reasoning item, `{m: true}` a message, `{c: callId}` a call -- and rides the
 * turn's `nativeState` beside the reasoning items. It is Winter BOOKKEEPING (`winter.` type): never
 * replayed itself, and persisted apart from the vendor items so an older runtime never sees it.
 * Emitted only when the order is not already reasoning-first.
 */
export const RESPONSES_LAYOUT_ITEM_TYPE = "winter.responses_layout" as const;
export type ResponsesLayoutEntry = { r: number } | { m: true } | { c: string };
export interface ResponsesLayoutItem {
  type: typeof RESPONSES_LAYOUT_ITEM_TYPE;
  order: ResponsesLayoutEntry[];
}

function isResponsesLayoutItem(item: unknown): item is ResponsesLayoutItem {
  return typeof item === "object" && item !== null && (item as { type?: unknown }).type === RESPONSES_LAYOUT_ITEM_TYPE && Array.isArray((item as { order?: unknown }).order);
}

/**
 * WS-23 (defect a): one assistant turn's own items (`own`, as the mapper produced them: messages and
 * calls in the engine's order) and its reasoning items, merged into the response's original output
 * order. Anything the layout does not place keeps the pre-layout behaviour: unplaced reasoning items
 * lead, unplaced own items follow in their own order.
 */
function interleaveWithLayout(reasoning: readonly unknown[], own: readonly unknown[], layout: ResponsesLayoutItem): unknown[] {
  const placedReasoning = new Set<number>();
  const placedOwn = new Set<number>();
  const merged: unknown[] = [];
  const takeOwn = (match: (item: { type?: unknown; call_id?: unknown }) => boolean): void => {
    const i = own.findIndex((item, n) => !placedOwn.has(n) && match(item as { type?: unknown; call_id?: unknown }));
    if (i === -1) return;
    placedOwn.add(i);
    merged.push(own[i]);
  };
  for (const entry of layout.order) {
    if ("r" in entry) {
      if (typeof entry.r === "number" && entry.r >= 0 && entry.r < reasoning.length && !placedReasoning.has(entry.r)) {
        placedReasoning.add(entry.r);
        merged.push(reasoning[entry.r]);
      }
    } else if ("c" in entry) takeOwn((item) => (item.type === "function_call" || item.type === "tool_search_call") && item.call_id === entry.c);
    else takeOwn((item) => item.type === "message");
  }
  return [...reasoning.filter((_, r) => !placedReasoning.has(r)), ...merged, ...own.filter((_, n) => !placedOwn.has(n))];
}

/** WS-23: which reasoning part a summary/reasoning-text delta belongs to -- its item and its index within it. */
function partKey(payload: Record<string, unknown>, indexField: "summary_index" | "content_index"): string {
  const item = typeof payload.item_id === "string" ? payload.item_id : typeof payload.output_index === "number" ? `#${payload.output_index}` : "";
  const index = typeof payload[indexField] === "number" ? payload[indexField] : 0;
  return `${item}:${index}`;
}

export class ResponsesStreamMapper {
  /**
   * `completionEvent`: the event this stream's descriptor says completes a response. `readableState`:
   * the descriptor's own reading of what the model's reasoning TEXT is (WS-23 fix round 1, M1) — it
   * decides whether `response.reasoning_text.delta` is raw exposed reasoning or a summary. Both are
   * injected so the mapper never reaches for a catalog itself.
   */
  constructor(
    private readonly completionEvent: string = "response.completed",
    private readonly readableState: "none" | "summary" | "full-exposed" = "none",
    private readonly tools: ResponsesStreamTools = {},
  ) {}

  /**
   * WS-23 (reasoning-state, defect d): the summary part the last summary delta belonged to. A response's
   * reasoning summary arrives as SEPARATE parts (one per `summary_index`, per reasoning item), each a
   * paragraph of its own, and the fold concatenates every delta it is handed -- two parts of 51 and 47
   * characters became one 98-character run-on. A blank line goes between parts, here, where the part
   * boundary is still visible.
   */
  private lastSummaryPart: string | undefined;

  private summaryDelta(part: string, delta: string): ProviderEvent[] {
    const separate = this.lastSummaryPart !== undefined && this.lastSummaryPart !== part;
    this.lastSummaryPart = part;
    return separate ? [{ type: "thinking_summary_delta", text: "\n\n" }, { type: "thinking_summary_delta", text: delta }] : [{ type: "thinking_summary_delta", text: delta }];
  }

  /** WS-23 (midconv): a client `tool_search_call` this request's ToolSearch answers. */
  private isClientToolSearch(itemType: string, item: Record<string, unknown>): boolean {
    return itemType === "tool_search_call" && item.execution === "client" && this.tools.toolSearchName !== undefined;
  }

  /** call ids of client tool-search calls already opened (`added`), so `done` does not open them twice. */
  private readonly openedSearches = new Set<string>();

  private sawToolCall = false;
  private sawRefusal = false;
  private started = false;
  /**
   * The completed reasoning items, ordered by the response's OWN `output_index` and, for anything
   * that carried none, by arrival after everything that did.
   *
   * A list rather than a `Map<number, unknown>` keyed on `output_index ?? 0` (minor 6): that default
   * made every indexless item collide on key 0, so a stream carrying two of them replayed ONE — a
   * silently truncated continuation whose next turn fails at the provider, far from here.
   */
  private readonly reasoningItems: Array<{ index: number; arrival: number; item: unknown }> = [];
  private arrivals = 0;
  /**
   * WS-23 (reasoning-state, defect a): where the response put its OTHER output items -- each message and
   * each call, by `output_index` -- so the replay can put the reasoning items back BETWEEN them rather
   * than all ahead of the turn. See `RESPONSES_LAYOUT_ITEM_TYPE`.
   */
  private readonly otherItems: Array<{ index: number; arrival: number; entry: ResponsesLayoutEntry }> = [];
  /** Item ids already reported as unrepresentable, so `added` + `done` for one call is ONE error (minor 5). */
  private readonly reportedUnrepresentable = new Set<string>();
  /** item_id -> call_id, so an arguments delta (which carries only the item id) can name its call. */
  private readonly callIdByItem = new Map<string, string>();
  /** call_ids whose arguments arrived as deltas — the final item must not re-send them. */
  private readonly streamedArguments = new Set<string>();
  private completed = false;

  map(data: string): ProviderEvent[] {
    const payload = parseSseJson(data);
    if (payload === undefined) return [];
    const type = typeof payload.type === "string" ? payload.type : "";
    // The DESCRIPTOR's terminator, checked before the fixed table: a row that declares its own
    // completion event is honoured, and every row that declares none lands on the `"response.completed"`
    // default this resolver returns, which is the same literal the table used to hard-code.
    if (type === this.completionEvent) return this.onCompleted(payload);
    switch (type) {
      case "response.created":
        return this.onCreated(payload);
      case "response.output_text.delta": {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        return delta.length > 0 ? [{ type: "text_delta", text: delta }] : [];
      }
      case "response.reasoning_summary_text.delta": {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        // A provider-produced SUMMARY. It rides the sidecar and the Winter-only frame, never
        // `assistant.message.content` (R6-8).
        return delta.length > 0 ? this.summaryDelta(`summary:${partKey(payload, "summary_index")}`, delta) : [];
      }
      case "response.reasoning_text.delta": {
        // WS-23 fix round 1 (M1): the reasoning TEXT channel. OpenAI uses it for raw chain of thought
        // (its open-weight models); xAI's own streaming example reads it beside the summary event for
        // grok-4.7, whose page calls that text "summarizations of the model's internal reasoning". It
        // used to fall into the ignore branch, so a model that streamed its readable reasoning here
        // showed none. Where it lands is the ROW's claim, not this event's name: `full-exposed` is the
        // complete trace (which may suppress a switch warning downstream, so it is never assumed);
        // anything else is treated as a summary, the conservative reading. Same destination rule as
        // the summary: never `assistant.message.content` (R6-8).
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        if (delta.length === 0) return [];
        return this.readableState === "full-exposed" ? [{ type: "thinking_exposed_delta", text: delta }] : this.summaryDelta(`text:${partKey(payload, "content_index")}`, delta);
      }
      case "response.output_item.added":
        return this.onItemAdded(payload);
      case "response.function_call_arguments.delta":
        return this.onArgumentsDelta(payload);
      case "response.output_item.done":
        return this.onItemDone(payload);
      case "response.incomplete":
        return this.onCompleted(payload);
      case "response.failed":
      case "error":
        // Review r1, I-6: a context overflow reported INSIDE the stream -- the Codex backend's shape, a
        // `response.failed` / `error` event whose `error.code` is `context_length_exceeded` -- is the same
        // typed `contextOverflow` a 400 carries, so the engine's reactive compaction reaches it too.
        return this.failureCode(payload) === "context_length_exceeded"
          ? [{ type: "error", error: { code: "bad_request", message: this.failureMessage(payload), retryable: false, providerCode: "context_length_exceeded", contextOverflow: true } }]
          : [{ type: "error", error: { code: "server", message: this.failureMessage(payload), retryable: false } }];
      default:
        // Forward compatibility: an unknown event is ignored, exactly as the port did. The ONE
        // exception is an unrepresentable CALL, which arrives on `output_item.added`/`.done` and is
        // handled there.
        return [];
    }
  }

  /**
   * Called when the byte stream ended.
   *
   * A stream that stopped before `response.completed` is a TRUNCATED turn, and reporting it as a
   * finished one would hand the caller a partial answer as if it were whole. It becomes a
   * non-retryable `network` error: bytes flowed, so R6-6 forbids replaying it.
   */
  finish(): ProviderEvent[] {
    if (this.completed) return [];
    return [{ type: "error", error: { code: "network", message: "the provider's stream ended before `response.completed` — the turn is incomplete", retryable: false } }];
  }

  private onCreated(payload: Record<string, unknown>): ProviderEvent[] {
    if (this.started) return [];
    this.started = true;
    const response = payload.response;
    const record = response !== null && typeof response === "object" ? (response as { id?: unknown; model?: unknown }) : {};
    return [
      {
        type: "message_start",
        ...(typeof record.id === "string" ? { id: record.id } : {}),
        ...(typeof record.model === "string" ? { model: record.model } : {}),
      },
    ];
  }

  private onItemAdded(payload: Record<string, unknown>): ProviderEvent[] {
    const item = itemOf(payload);
    if (item === undefined) return [];
    const itemType = typeof item.type === "string" ? item.type : "";
    if (this.isClientToolSearch(itemType, item)) {
      // Opened here, its arguments (an OBJECT, complete only on `done`) handed over there.
      const callId = typeof item.call_id === "string" ? item.call_id : undefined;
      if (callId === undefined) return [];
      this.openedSearches.add(callId);
      this.sawToolCall = true;
      return [{ type: "tool_call_start", id: callId, name: this.tools.toolSearchName! }];
    }
    if (isUnrepresentableCall(itemType)) return this.unrepresentable(itemType, item);
    if (itemType !== "function_call") return [];
    const callId = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : undefined;
    const name = this.fullName(item);
    if (callId === undefined || name === undefined) {
      return [{ type: "error", error: { code: "bad_request", message: "the provider opened a function call with no call id or name, which cannot be represented as a tool call", retryable: false } }];
    }
    if (typeof item.id === "string") this.callIdByItem.set(item.id, callId);
    this.sawToolCall = true;
    return [{ type: "tool_call_start", id: callId, name }];
  }

  private onArgumentsDelta(payload: Record<string, unknown>): ProviderEvent[] {
    const delta = typeof payload.delta === "string" ? payload.delta : "";
    if (delta.length === 0) return [];
    const itemId = typeof payload.item_id === "string" ? payload.item_id : undefined;
    const callId = itemId !== undefined ? this.callIdByItem.get(itemId) : undefined;
    if (callId === undefined) return [];
    this.streamedArguments.add(callId);
    return [{ type: "tool_call_delta", id: callId, argumentsJsonDelta: delta }];
  }

  private onItemDone(payload: Record<string, unknown>): ProviderEvent[] {
    const item = itemOf(payload);
    if (item === undefined) return [];
    const itemType = typeof item.type === "string" ? item.type : "";

    if (itemType === "reasoning") {
      // ONLY items with non-empty `encrypted_content` are replayable — a summary-only reasoning item
      // (which is what arrives when `include` was not sent) would restore nothing on replay, so
      // capturing it would grow the next request for no benefit. `id` and `status` are stripped:
      // both are response-only fields the endpoint clears on a `store: false` replay.
      const encrypted = item.encrypted_content;
      if (typeof encrypted === "string" && encrypted.length > 0) {
        const { id: _id, status: _status, ...replayable } = item;
        // `Number.MAX_SAFE_INTEGER` for an item with no `output_index`: it sorts after everything
        // the response DID position, and the arrival counter keeps two such items distinct.
        const index = typeof payload.output_index === "number" ? payload.output_index : Number.MAX_SAFE_INTEGER;
        this.reasoningItems.push({ index, arrival: this.arrivals++, item: replayable });
      }
      return [];
    }
    this.noteLayout(payload, itemType, item);

    if (this.isClientToolSearch(itemType, item)) {
      const callId = typeof item.call_id === "string" ? item.call_id : undefined;
      if (callId === undefined) {
        return [{ type: "error", error: { code: "bad_request", message: "the provider emitted a client tool_search_call with no call id, which cannot be answered", retryable: false } }];
      }
      const events: ProviderEvent[] = [];
      if (!this.openedSearches.has(callId)) {
        this.openedSearches.add(callId);
        this.sawToolCall = true;
        events.push({ type: "tool_call_start", id: callId, name: this.tools.toolSearchName! });
      }
      const args = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {});
      if (args.length > 0) events.push({ type: "tool_call_delta", id: callId, argumentsJsonDelta: args });
      events.push({ type: "tool_call_end", id: callId });
      return events;
    }

    if (isUnrepresentableCall(itemType)) return this.unrepresentable(itemType, item);

    if (itemType === "function_call") {
      const callId = typeof item.call_id === "string" ? item.call_id : undefined;
      if (callId === undefined) return [];
      const events: ProviderEvent[] = [];
      if (!this.streamedArguments.has(callId)) {
        // The provider sent the complete item and no deltas (the codex backend's own behaviour). The
        // fold accumulates deltas, so the whole argument string is handed over as one.
        const args = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {});
        if (args.length > 0) events.push({ type: "tool_call_delta", id: callId, argumentsJsonDelta: args });
      }
      events.push({ type: "tool_call_end", id: callId });
      return events;
    }

    if (itemType === "message") this.noteRefusal(item);
    return [];
  }

  /** WS-23 (defect a): one message or call's place in the output, for the layout. */
  private noteLayout(payload: Record<string, unknown>, itemType: string, item: Record<string, unknown>): void {
    const index = typeof payload.output_index === "number" ? payload.output_index : Number.MAX_SAFE_INTEGER;
    let entry: ResponsesLayoutEntry | undefined;
    if (itemType === "message") entry = { m: true };
    else if (itemType === "function_call" || itemType === "tool_search_call") {
      const callId = typeof item.call_id === "string" ? item.call_id : undefined;
      if (callId !== undefined) entry = { c: callId };
    }
    if (entry !== undefined) this.otherItems.push({ index, arrival: this.arrivals++, entry });
  }

  /**
   * WS-23 (defect a): the layout item, or `undefined` when every reasoning item already came before
   * every message and call -- the shape the replay produces without one (reasoning first), so the
   * common turn's native state and its replay stay byte-identical to before.
   */
  private layoutFor(sorted: ReadonlyArray<{ index: number; arrival: number }>): ResponsesLayoutItem | undefined {
    const all = [
      ...sorted.map((entry, r) => ({ index: entry.index, arrival: entry.arrival, entry: { r } as ResponsesLayoutEntry })),
      ...this.otherItems,
    ].sort((a, b) => a.index - b.index || a.arrival - b.arrival);
    const firstOther = all.findIndex((e) => !("r" in e.entry));
    const lastReasoning = all.map((e) => "r" in e.entry).lastIndexOf(true);
    if (firstOther === -1 || lastReasoning < firstOther) return undefined;
    return { type: RESPONSES_LAYOUT_ITEM_TYPE, order: all.map((e) => e.entry) };
  }

  private onCompleted(payload: Record<string, unknown>): ProviderEvent[] {
    if (this.completed) return [];
    this.completed = true;
    const events: ProviderEvent[] = [];
    const response = payload.response;
    const record = response !== null && typeof response === "object" ? (response as Record<string, unknown>) : {};

    // THE COMPLETION EVENT IS THE ONLY SOURCE OF NATIVE STATE. Emitted once, complete, in output
    // order — the order §5.3 requires them to be replayed in.
    if (this.reasoningItems.length > 0) {
      const sorted = [...this.reasoningItems].sort((a, b) => a.index - b.index || a.arrival - b.arrival);
      const layout = this.layoutFor(sorted);
      events.push({ type: "native_state", items: [...sorted.map((entry) => entry.item), ...(layout !== undefined ? [layout] : [])] });
    }

    const usage = record.usage;
    if (usage !== null && typeof usage === "object") {
      const u = usage as { input_tokens?: unknown; output_tokens?: unknown; input_tokens_details?: unknown };
      const cached = u.input_tokens_details !== null && typeof u.input_tokens_details === "object" ? (u.input_tokens_details as { cached_tokens?: unknown }).cached_tokens : undefined;
      // Review r1 finding 5: `input_tokens` is the TOTAL prompt and `cached_tokens` a subset of it;
      // the seam's convention (types.ts) is Anthropic's -- non-cached input, cache read disjoint.
      events.push({
        type: "usage",
        ...normalizedPromptUsage(typeof u.input_tokens === "number" ? u.input_tokens : 0, typeof cached === "number" ? cached : undefined),
        outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
      });
    }

    // A refusal can also arrive only in the final response object (a non-streamed message part).
    const output = record.output;
    if (Array.isArray(output)) for (const item of output) if (item !== null && typeof item === "object") this.noteRefusal(item as Record<string, unknown>);

    const incomplete = record.incomplete_details;
    const incompleteReason = incomplete !== null && typeof incomplete === "object" ? (incomplete as { reason?: unknown }).reason : undefined;
    const stopReason = this.sawRefusal ? "refusal" : incompleteReason === "max_output_tokens" ? "max_tokens" : this.sawToolCall ? "tool_use" : "end_turn";
    events.push({ type: "done", stopReason });
    return events;
  }

  /** A function call's Winter name: a namespaced call (`{namespace, name}`) is looked up in this request's tools. */
  private fullName(item: Record<string, unknown>): string | undefined {
    const name = typeof item.name === "string" ? item.name : undefined;
    if (name === undefined || typeof item.namespace !== "string") return name;
    return this.tools.namespaced?.get(namespacedKey(item.namespace, name)) ?? name;
  }

  private noteRefusal(item: Record<string, unknown>): void {
    const content = item.content;
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (part !== null && typeof part === "object" && (part as { type?: unknown }).type === "refusal") this.sawRefusal = true;
    }
  }

  /**
   * ONE error per unrepresentable CALL, not one per lifecycle event (minor 5).
   *
   * A call appears twice in the stream (`output_item.added`, then `.done`), so reporting on both
   * emitted two errors for one refusal — which a consumer counting failures reads as two problems.
   */
  private unrepresentable(itemType: string, item: Record<string, unknown>): ProviderEvent[] {
    const id = typeof item.id === "string" ? item.id : itemType;
    if (this.reportedUnrepresentable.has(id)) return [];
    this.reportedUnrepresentable.add(id);
    return [this.unrepresentableError(itemType)];
  }

  private unrepresentableError(itemType: string): ProviderEvent {
    return {
      type: "error",
      error: {
        code: "capability",
        message: `the model invoked a "${itemType}", which this adapter cannot represent as a tool call — Winter fails the turn rather than dropping the call silently (WS-13 §9)`,
        retryable: false,
      },
    };
  }

  /** The failure's own structured code (`response.error.code`, the `error` event's `error.code`, or its top-level `code`). */
  private failureCode(payload: Record<string, unknown>): string | undefined {
    const response = payload.response;
    const error = response !== null && typeof response === "object" ? (response as { error?: unknown }).error : payload.error;
    const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : payload.code;
    return typeof code === "string" ? code : undefined;
  }

  private failureMessage(payload: Record<string, unknown>): string {
    const response = payload.response;
    const error = response !== null && typeof response === "object" ? (response as { error?: unknown }).error : payload.error;
    const message = error !== null && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
    return typeof message === "string" && message.length > 0 ? message : "the provider reported the response failed";
  }
}

function itemOf(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = payload.item;
  return item !== null && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
}

// --- the shared turn driver --------------------------------------------------------------------------------

/** What a Responses-speaking adapter (plain OpenAI, codex-oauth, Azure's preview surface) has to supply beyond the request body. */
export interface ResponsesTurnPlan {
  /** The provider-local model id this plan is for — the descriptor lookup's key (review round 1, C). */
  model: string;
  url: string;
  headers: Record<string, string>;
  endpoint: ResolvedEndpoint;
  ctx: ProviderContext;
  options: OpenAiAdapterOptions;
  body: string;
  beforeAttempt?: (attempt: number) => Promise<void>;
  recover?: (status: number, attempt: number) => Promise<Record<string, string> | undefined>;
  /** Observes the refused response before its body is read — the codex quota manager's only honest source for a limit window (finding I1). */
  onRefused?: (response: Response) => void;
  /** Observed after a successful turn — the codex quota manager's "we are no longer limited" hook. */
  onSuccess?: () => void;
  /** Observed on a rate-limited failure, BEFORE the retry sleeps. The one producer of `rate_limit` events (R6-B). */
  onRateLimited?: (retry: Extract<ProviderEvent, { type: "retry" }>, queue: EventQueue) => void;
  /** Pre-seeded observations (an `auth_status` from a token refresh that already happened). */
  queue?: EventQueue;
  /** WS-23 (midconv): how this request's tools come back from the stream (`responsesStreamTools`). */
  streamTools?: ResponsesStreamTools;
}

/**
 * Opens the stream, consumes it, and yields the normalized events.
 *
 * `policy.commit()` fires on the FIRST SSE event, not at header time: WS-13 §13's line is the first
 * response byte consumed, and a 5xx that arrives with headers and an error body is still safely
 * retryable.
 */
export async function* streamResponsesTurn(plan: ResponsesTurnPlan, signal: AbortSignal | undefined): AsyncIterable<ProviderEvent> {
  const queue = plan.queue ?? new EventQueue();
  const policy = makeRetryPolicy(plan.options);
  const descriptor = plan.options.descriptors?.(plan.model, plan.ctx.connection.providerId);
  const mapper = new ResponsesStreamMapper(responsesCompletionEvent(descriptor), descriptor?.reasoning?.readableState?.value ?? "none", plan.streamTools ?? {});
  let response: Response;
  // WS-23 (reasoning-state, defect b): the body actually sent -- the plan's, or, after the endpoint
  // refused a replayed reasoning item's encrypted content, the same body without the replayed reasoning.
  // Review r1, M-2: items an endpoint already refused to decrypt are not replayed again -- a permanently
  // undecryptable item would otherwise cost one failed 400 on every later request of the session.
  let body = withoutKnownUndecryptable(plan.body);
  let droppedReplay = false;
  for (;;) {
    try {
      response = yield* pumpEvents(
        queue,
        openStream(
          {
            url: plan.url,
            headers: plan.headers,
            body,
            policy: plan.endpoint.policy,
            ctx: plan.ctx,
            options: plan.options,
            ...(signal !== undefined ? { signal } : {}),
            ...(plan.beforeAttempt !== undefined ? { beforeAttempt: plan.beforeAttempt } : {}),
            ...(plan.recover !== undefined ? { recover: plan.recover } : {}),
            ...(plan.onRefused !== undefined ? { onRefused: plan.onRefused } : {}),
          },
          policy,
          (event) => {
            // R6-B: the quota manager is the ONE producer of `rate_limit`. It observes the retry here
            // — before the backoff is taken — so a subscription-quota state reaches the host at the
            // same moment the retry does, never after the turn.
            if (event.type === "retry" && event.errorStatus === 429) plan.onRateLimited?.(event, queue);
            queue.push(event);
          },
        ),
      );
      break;
    } catch (err) {
      // WS-23 (reasoning-state, defect b): ONE retry of this request without the reasoning items it
      // replayed, when the endpoint refused their encrypted content. Pre-stream (a 400 carries no
      // stream), so no byte has been consumed and nothing is re-sent that already ran (R6-6). The turn
      // then continues without the model's prior reasoning -- the visible conversation is intact -- rather
      // than failing outright; the stored state is untouched, so a later request replays it again.
      // Never twice: `droppedReplay` ends the loop on the next refusal of any kind.
      if (!droppedReplay && isEncryptedContentRejection(err)) {
        const stripped = withoutReplayedReasoning(body);
        if (stripped !== undefined) {
          rememberUndecryptable(body);
          droppedReplay = true;
          body = stripped;
          plan.ctx.log({ kind: "provider.replay_dropped", providerId: plan.ctx.connection.providerId, model: plan.model, detail: { reason: "encrypted_content_rejected" } });
          continue;
        }
      }
      yield errorEvent(err);
      return;
    }
  }

  if (response.body === null) {
    yield { type: "error", error: { code: "network", message: "the provider returned no response body", retryable: false } };
    return;
  }

  try {
    for await (const sse of parseSse(response.body, {
      stallTimeoutMs: plan.ctx.stallTimeoutMs,
      ...(signal !== undefined ? { signal } : {}),
      // Telemetry counts BYTES, never content (Global Constraints).
      onBytes: (n) => plan.ctx.log({ kind: "provider.stream", providerId: plan.ctx.connection.providerId, bytes: n }),
    })) {
      policy.commit();
      for (const event of mapper.map(sse.data)) yield event;
      // Anything an observer queued while the stream was running (a quota state change) gets out
      // HERE: `pumpEvents` only pumps while `openStream` is in flight, so a push after that point
      // has no other door.
      for (const event of queue.drain()) yield event;
    }
    for (const event of mapper.finish()) yield event;
    plan.onSuccess?.();
    // The recovery observation is pushed BY `onSuccess`, i.e. after the pump has already returned.
    // Without this drain it was queued and never yielded — the "your account is serving again"
    // event simply never reached a host, and a test asserting only the FIRST rate_limit event
    // passed anyway.
    for (const event of queue.drain()) yield event;
  } catch (err) {
    yield errorEvent(err);
  }
}

/**
 * Review r1, M-2: the replayed reasoning items an endpoint refused to decrypt, by a hash of their
 * `encrypted_content` -- remembered for the process, bounded (oldest forgotten first). Adapters hold no
 * session identity (and the seam is frozen), so the memory is per ITEM rather than a per-session flag,
 * which is the same thing for the session that holds the item, and narrower: a later turn's own new
 * reasoning still replays. Every item of a refused request is suspect -- the 400 does not say which one.
 */
const UNDECRYPTABLE = new Set<string>();
const UNDECRYPTABLE_MAX = 4_096;

function encryptedHash(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null || (item as { type?: unknown }).type !== "reasoning") return undefined;
  const enc = (item as { encrypted_content?: unknown }).encrypted_content;
  return typeof enc === "string" && enc.length > 0 ? createHash("sha256").update(enc).digest("hex") : undefined;
}

function rememberUndecryptable(body: string): void {
  let input: unknown;
  try {
    input = (JSON.parse(body) as { input?: unknown }).input;
  } catch {
    return;
  }
  if (!Array.isArray(input)) return;
  for (const item of input) {
    const hash = encryptedHash(item);
    if (hash === undefined) continue;
    UNDECRYPTABLE.delete(hash);
    UNDECRYPTABLE.add(hash);
    if (UNDECRYPTABLE.size > UNDECRYPTABLE_MAX) UNDECRYPTABLE.delete(UNDECRYPTABLE.values().next().value!);
  }
}

/** The body without any replayed reasoning item already known undecryptable (the body unchanged when none is). */
function withoutKnownUndecryptable(body: string): string {
  if (UNDECRYPTABLE.size === 0) return body;
  let parsed: { input?: unknown };
  try {
    parsed = JSON.parse(body) as { input?: unknown };
  } catch {
    return body;
  }
  if (!Array.isArray(parsed.input)) return body;
  const kept = parsed.input.filter((item) => {
    const hash = encryptedHash(item);
    return hash === undefined || !UNDECRYPTABLE.has(hash);
  });
  return kept.length === parsed.input.length ? body : JSON.stringify({ ...parsed, input: kept });
}

/**
 * WS-23 (reasoning-state, defect b): the request body with every replayed `reasoning` input item removed,
 * or `undefined` when it replayed none (then there is nothing a retry could change). The body is Winter's
 * own serialization, so a parse failure is impossible in practice and reads as "nothing to strip".
 */
function withoutReplayedReasoning(body: string): string | undefined {
  let parsed: { input?: unknown };
  try {
    parsed = JSON.parse(body) as { input?: unknown };
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed.input)) return undefined;
  const kept = parsed.input.filter((item) => !(typeof item === "object" && item !== null && (item as { type?: unknown }).type === "reasoning"));
  return kept.length === parsed.input.length ? undefined : JSON.stringify({ ...parsed, input: kept });
}

// --- the adapter -------------------------------------------------------------------------------------------

export function createResponsesAdapter(options: OpenAiAdapterOptions): ProviderAdapter {
  return {
    id: "winter.openai-responses",
    version: "1",
    family: "openai",
    protocol: "openai-responses",

    async validateCredential(ref: CredentialRef, ctx: ProviderContext): Promise<CredentialStatus> {
      const endpoint = resolveEndpoint(ctx, options, vendorFallbackFor(ctx));
      const auth = await resolveAuth(ctx, "bearer");
      const headers = buildHeaders({ policy: endpoint.policy, protocol: { accept: "application/json", ...auth.headers }, privileged: privilegedHeaders(optionsForProvider(options, ctx)), identity: identityFor(options, ctx), userSupplied: ctx.connection.headers });
      return validateViaModels(ref, ctx, endpoint, headers, options, auth.material !== null);
    },

    async listModels(ctx: DiscoveryContext): Promise<ModelCatalogResult> {
      const endpoint = resolveEndpoint(ctx, options, vendorFallbackFor(ctx));
      const auth = await resolveAuth(ctx, "bearer");
      const headers = buildHeaders({ policy: endpoint.policy, protocol: { accept: "application/json", ...auth.headers }, privileged: privilegedHeaders(optionsForProvider(options, ctx)), identity: identityFor(options, ctx), userSupplied: ctx.connection.headers });
      return fetchOpenAiModels(ctx, endpoint, headers, options);
    },

    streamTurn(req: TurnRequest, ctx: ProviderContext): AsyncIterable<ProviderEvent> {
      return responsesTurn(req, ctx, optionsForProvider(options, ctx), vendorFallbackFor(ctx), (base) => `${base}/responses`);
    },

    mapEffort(effort: TurnRequest["effort"], model: WinterModelDescriptor) {
      const mapped = mapEffortAgainst(effort, model);
      return mapped.ok ? { ok: true as const, value: mapped.value } : mapped;
    },

    capabilities: capabilitiesFrom,
  };
}

/** PRIVILEGED headers (R6-L): identifiers that only mean something at the reviewed endpoint they were minted for. `applyPrivilegedHeaders` drops them for a user endpoint. */
export function privilegedHeaders(options: OpenAiAdapterOptions): Record<string, string> {
  return {
    ...(options.organization !== undefined ? { "OpenAI-Organization": options.organization } : {}),
    ...(options.project !== undefined ? { "OpenAI-Project": options.project } : {}),
  };
}

/**
 * The plain-OpenAI (and Azure-preview) turn: resolve the endpoint and credential, validate the
 * SELECTION before anything is sent, then stream.
 *
 * Everything that can be refused is refused here, synchronously enough that the fake records ZERO
 * requests — which is what the effort-mapping and limit-rejection fixtures assert on.
 */
export async function* responsesTurn(
  req: TurnRequest,
  ctx: ProviderContext,
  options: OpenAiAdapterOptions,
  fallbackBaseUrl: string | undefined,
  urlFor: (baseUrl: string) => string,
  extraProtocolHeaders: Record<string, string> = {},
): AsyncIterable<ProviderEvent> {
  let plan: ResponsesTurnPlan;
  try {
    const descriptor = options.descriptors?.(req.model, ctx.connection.providerId);
    assertRepresentableTools(req.tools);
    assertConfigurationUpdates(req, descriptor);
    assertResponsesToolFeatures(req, descriptor);
    const reasoning = resolveReasoning(req, descriptor);
    const parametersInPlay = [
      ...(reasoning.enabled && reasoning.effort !== undefined ? ["reasoning", "reasoning.effort"] : []),
      ...(reasoning.summary !== undefined ? ["reasoning.summary"] : []),
      ...(reasoning.wantsEncryptedContent ? ["include"] : []),
      ...(req.maxOutputTokens !== undefined ? ["max_output_tokens"] : []),
      ...((req.tools?.length ?? 0) > 0 ? ["tools"] : []),
    ];
    assertWithinLimits(req, descriptor, parametersInPlay);
    const endpoint = resolveEndpoint(ctx, options, fallbackBaseUrl);
    const auth = await resolveAuth(ctx, "bearer");
    if (auth.material === null && !endpoint.policy.local) {
      throw capabilityRefusal(`no credential is configured for provider "${ctx.connection.providerId}" — an OpenAI-family endpoint that is not a declared local installation needs one`);
    }
    const headers = buildHeaders({
      policy: endpoint.policy,
      protocol: { "content-type": "application/json", accept: "text/event-stream", ...extraProtocolHeaders, ...auth.headers },
      // NO `chatgpt-account-id` (fix-wave R-FW-1 / whole-branch review I-1) — the twin of the branch
      // removed from `chat-completions.ts`. The codex adapter builds its own headers
      // (`codexHeaders`) from its own credential material and is unaffected; this plain Responses
      // adapter serves any row on `winter.openai-responses`, none of which is the codex backend.
      privileged: privilegedHeaders(options),
      identity: identityFor(options, ctx),
      userSupplied: ctx.connection.headers,
    });
    plan = { model: req.model, url: urlFor(endpoint.baseUrl), headers, endpoint, ctx, options, body: JSON.stringify(buildResponsesBody(req, reasoning, descriptor)), streamTools: responsesStreamTools(req, descriptor) };
  } catch (err) {
    yield errorEvent(err);
    return;
  }
  yield* streamResponsesTurn(plan, req.signal);
}
