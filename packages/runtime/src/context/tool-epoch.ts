// WS-23 (midconv): THE TOOL EPOCH -- `tools[]` frozen per cache epoch, and every later change to what the
// model may call recorded as an ADDITIVE transcript entry, replayed in place.
//
// WHY. `tools` sits at the very start of the rendered prompt on both vendors, so any edit to it -- a tool
// added by a late MCP server, one withdrawn by a permission-mode switch, a description that changed --
// invalidates the whole cached prefix ("tools were added, removed, or reordered", Anthropic's
// cache-diagnostics `tools_changed`; on Claude Fable 5.1 / Opus 5.5 it also drops every later thinking
// block). Both vendors now document a way to change the callable set WITHOUT editing `tools`:
//   - Anthropic: a `role: "system"` message carrying `tool_addition` / `tool_removal` blocks, by
//     reference (`mid-conversation-tool-changes-2026-07-01`) or by value (`inline-tools-2026-09-15`)
//     (https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages);
//   - OpenAI Responses: an `additional_tools` developer item to add, `tool_choice: allowed_tools` to
//     restrict (https://developers.openai.com/api/docs/guides/tools-tool-search,
//     https://developers.openai.com/api/docs/guides/function-calling).
//
// THE MODEL. An epoch starts at a session's first request on a model whose row documents a mechanism,
// after every compaction, and after a model switch. Its `tools` array is written into the history as a
// `tool_epoch` attachment (the FULL specs: after a by-value redefinition the live registry holds the NEW
// definition while `tools` must keep sending the OLD bytes, so nothing else could rebuild it on resume).
// Each later request diffs the LIVE tool list against the epoch folded with its `tool_changes` entries;
// a difference is appended as a new `tool_changes` entry at the tail -- right after the user or
// tool-result turn that precedes the generation, exactly where both vendors want it -- and persisted.
// Every later request replays the same entries at the same positions, so the request stays a byte
// prefix of the next one. A resumed session reads both back off the transcript.
//
// PURE. Nothing here touches the engine's state; the engine (engine.ts, `planToolsForRequest`) owns the
// flags, the persistence and the fallbacks. Both attachment types are Winter bookkeeping: their rendered
// text never reaches a provider (context/request-layout.ts converts or drops them before the merge).
import type { ProviderMessage, ProviderToolSpec } from "../engine.ts";
import type { ToolChangeSet } from "@yanlinglabs/winter-provider-runtime";
import type { AttachmentPayload } from "./attachments.ts";

/**
 * Which vendor form this epoch's changes take. Chosen per model from its catalog evidence:
 *   - `anthropic-inline`: by value and by reference (`inlineToolDefinitions`, Claude API only);
 *   - `anthropic-reference`: by reference only (`midConversationToolChanges`);
 *   - `openai`: `additional_tools` and/or `allowed_tools` (`additionalToolsItem` / `allowedToolsChoice`).
 */
export type ToolChangeMechanism = "anthropic-reference" | "anthropic-inline" | "openai";

export const TOOL_EPOCH_ATTACHMENT = "tool_epoch";
export const TOOL_CHANGES_ATTACHMENT = "tool_changes";

/** The epoch's frozen `tools` array, verbatim, and the model and mechanism it was frozen for. */
export interface ToolEpochAttachment extends AttachmentPayload {
  type: "tool_epoch";
  mechanism: ToolChangeMechanism;
  /** The catalog key of the model the epoch belongs to (`null` for a session with no identity). */
  modelKey: string | null;
  tools: ProviderToolSpec[];
}

/**
 * One change point. `declare` is appended to `tools` from here on (Anthropic's deferred declarations:
 * a tool must be declared before a reference can name it); `remove` and `add` are what the model reads
 * at this position.
 */
export interface ToolChangesAttachment extends AttachmentPayload {
  type: "tool_changes";
  mechanism: ToolChangeMechanism;
  /**
   * WS-23 (reasoning-state): the model whose epoch this change extends. Several models' epochs can now
   * sit in one history (a switch no longer retires the earlier model's), so each change names its own.
   * Absent on an entry a dev build wrote into the transcript: it belongs to the epoch before it.
   */
  modelKey?: string | null;
  declare: ProviderToolSpec[];
  remove: string[];
  add: ToolChangeSet["add"];
}

export function isToolEpochMessage(message: ProviderMessage): boolean {
  return message.meta?.attachment.type === TOOL_EPOCH_ATTACHMENT;
}

export function isToolChangesMessage(message: ProviderMessage): boolean {
  return message.meta?.attachment.type === TOOL_CHANGES_ATTACHMENT;
}

/** Either bookkeeping attachment -- neither is ever sent as text. */
export function isToolBookkeeping(message: ProviderMessage): boolean {
  return isToolEpochMessage(message) || isToolChangesMessage(message);
}

/** The identity of one definition as the model reads it: name, description, schema -- never Winter's own flags. */
export function toolDefinitionKey(spec: { name: string; description: string; inputSchema: Record<string, unknown> }): string {
  return JSON.stringify([spec.name, spec.description, spec.inputSchema]);
}

/**
 * The history's newest epoch for `mechanism` on `modelKey` -- that MODEL's own, wherever it sits.
 *
 * WS-23 (reasoning-state): a later epoch of ANOTHER model no longer retires this one. The tool list is a
 * cache quirk of one model, so each model keeps its own epoch in the history and reads only its own:
 * after Claude -> GPT -> Claude, Claude's epoch (and the cached prefix it heads) is still there to
 * resume. Whether it SHOULD be resumed -- the cache may have expired while the other model ran -- is the
 * engine's call (`planToolsForRequest`, the TTL rule); this only finds it.
 */
export function activeToolEpoch(history: readonly ProviderMessage[], mechanism: ToolChangeMechanism, modelKey: string | undefined): { index: number; epoch: ToolEpochAttachment } | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (!isToolEpochMessage(message)) continue;
    const epoch = message.meta!.attachment as ToolEpochAttachment;
    if (epoch.mechanism === mechanism && epoch.modelKey === (modelKey ?? null)) return { index: i, epoch };
  }
  return undefined;
}

/**
 * The `tool_changes` entries that belong to the epoch at `epochIndex`, in order: after it, on its
 * mechanism, and of its MODEL (WS-23 -- another model's changes in between are that model's). A change
 * with no `modelKey` (a dev-build transcript entry) belongs to whichever epoch precedes it.
 */
export function epochChangeMessages(history: readonly ProviderMessage[], epochIndex: number, mechanism: ToolChangeMechanism): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  const own = (history[epochIndex]!.meta!.attachment as ToolEpochAttachment).modelKey;
  let preceding = own;
  for (let i = epochIndex + 1; i < history.length; i++) {
    const message = history[i]!;
    if (isToolEpochMessage(message)) {
      preceding = (message.meta!.attachment as ToolEpochAttachment).modelKey;
      continue;
    }
    if (!isToolChangesMessage(message)) continue;
    const change = message.meta!.attachment as ToolChangesAttachment;
    if (change.mechanism === mechanism && (change.modelKey !== undefined ? change.modelKey : preceding) === own) out.push(message);
  }
  return out;
}

/** What the model can see at the tail of an epoch: the declared `tools` array, and the tools it may call. */
export interface ToolState {
  /** The request's `tools` array: the frozen list, then every `declare` in order. Never sorted again. */
  declared: ProviderToolSpec[];
  /** Name -> the definition the model currently has for it. */
  available: Map<string, ProviderToolSpec>;
}

/**
 * Folds an epoch and its change entries into the state at the tail. `referenced` are the deferred names
 * a ToolSearch result surfaced (`tool_result.loadedTools`): on Anthropic those are callable through the
 * `tool_reference` blocks the adapter writes into the result, so they count as available.
 */
export function foldToolState(epoch: ToolEpochAttachment, changes: readonly ProviderMessage[], referenced: ReadonlySet<string> = new Set()): ToolState {
  const declared = epoch.tools.map((t) => ({ ...t }));
  const byName = new Map(declared.map((t) => [t.name, t] as const));
  const available = new Map<string, ProviderToolSpec>();
  for (const spec of declared) if (spec.deferLoading !== true || referenced.has(spec.name)) available.set(spec.name, spec);
  for (const message of changes) {
    const change = message.meta!.attachment as ToolChangesAttachment;
    for (const spec of change.declare) {
      declared.push({ ...spec });
      byName.set(spec.name, spec);
      if (referenced.has(spec.name)) available.set(spec.name, spec);
    }
    for (const name of change.remove) available.delete(name);
    for (const addition of change.add) {
      if (addition.type === "reference") {
        const spec = byName.get(addition.name);
        if (spec !== undefined) available.set(addition.name, spec);
      } else {
        available.set(addition.name, { name: addition.name, description: addition.description, inputSchema: addition.inputSchema });
      }
    }
  }
  return { declared, available };
}

/** The frozen `tools` array for a NEW epoch. OpenAI's client tool search never declares a deferred tool (it rides the search output). */
export function epochToolsFor(live: readonly ProviderToolSpec[], mechanism: ToolChangeMechanism): ProviderToolSpec[] {
  return live.filter((t) => mechanism !== "openai" || t.deferLoading !== true).map((t) => ({ ...t }));
}

/** What the mechanism can express, from the row's evidence. */
export interface ToolChangeCaps {
  /** OpenAI: an `additional_tools` item may add or redefine a tool. */
  additionalTools?: boolean;
  /** OpenAI: `tool_choice: allowed_tools` may restrict the callable set. */
  allowedTools?: boolean;
}

export type ToolDiff =
  | { kind: "same"; allowedTools?: string[] }
  | { kind: "change"; change: Pick<ToolChangesAttachment, "declare" | "remove" | "add">; allowedTools?: string[] }
  /** The mechanism cannot express this change: start a new epoch (today's full rebuild of `tools`, once). */
  | { kind: "new-epoch"; reason: string };

/**
 * The live tool list against the folded state: what to append, or that the epoch cannot express it.
 *
 * `live` is the engine's own per-request list (sorted by name; on a deferred-loading row, deferred tools
 * carry `deferLoading`, which means "declared, not shown"). Deterministic: removals and additions are in
 * name order, declarations in `live` order.
 */
export function diffToolState(live: readonly ProviderToolSpec[], state: ToolState, mechanism: ToolChangeMechanism, caps: ToolChangeCaps = {}): ToolDiff {
  return mechanism === "openai" ? diffOpenAi(live, state, caps) : diffAnthropic(live, state, mechanism);
}

function diffAnthropic(live: readonly ProviderToolSpec[], state: ToolState, mechanism: "anthropic-reference" | "anthropic-inline"): ToolDiff {
  const inline = mechanism === "anthropic-inline";
  const declaredByName = new Map(state.declared.map((t) => [t.name, t] as const));
  // "Keep at least one non-deferred tool in `tools`" -- and on a reference-only row a late tool can only
  // be declared deferred, which the API refuses when nothing in `tools` is eager.
  const hasEagerDeclared = state.declared.some((t) => t.deferLoading !== true);
  const liveNames = new Set(live.map((t) => t.name));
  const remove = [...state.available.keys()].filter((name) => !liveNames.has(name)).sort(byCodeUnit);
  // NOT named `declare`: a statement starting `declare.push(...)` is read as a TypeScript ambient
  // declaration by the transpiler and silently dropped.
  const declarations: ProviderToolSpec[] = [];
  const add: ToolChangeSet["add"] = [];
  for (const spec of live) {
    const have = state.available.get(spec.name);
    const declaredAs = declaredByName.get(spec.name);
    if (spec.deferLoading === true) {
      if (declaredAs === undefined) {
        // A tool that appeared mid-session and is deferred: declared `defer_loading: true` AFTER the
        // frozen list (never sorted in -- the deferred tail is outside the rendered prefix, the frozen
        // head is not) and NOT announced. RULING (fix round 1): it stays deferred like every tool declared
        // at the start -- ToolSearch surfaces it when the model asks, which is what deferral is for. The
        // live probe (Anthropic request #14) showed appending the declaration keeps the cache. claude
        // 2.1.282 announces late deferred MCP tools by reference instead; that puts every late server's
        // definitions into context, which is the cost deferral exists to avoid.
        if (!hasEagerDeclared) return { kind: "new-epoch", reason: "no non-deferred tool is declared, so a late deferred declaration would be refused" };
        declarations.push({ ...spec });
        continue;
      }
      if (toolDefinitionKey(declaredAs) === toolDefinitionKey(spec)) continue;
      // The declared (deferred) definition is stale. Visible already -> redefine it by value where the row
      // can; still hidden -> a later reference would surface the OLD definition, so the epoch restarts.
      if (have !== undefined && inline) add.push(definition(spec));
      else return { kind: "new-epoch", reason: `the deferred tool "${spec.name}" changed its definition` };
      continue;
    }
    if (have === undefined) {
      if (declaredAs !== undefined && toolDefinitionKey(declaredAs) === toolDefinitionKey(spec)) add.push({ type: "reference", name: spec.name });
      else if (inline) add.push(definition(spec));
      else if (declaredAs === undefined) {
        if (!hasEagerDeclared) return { kind: "new-epoch", reason: "no non-deferred tool is declared, so a late deferred declaration would be refused" };
        declarations.push({ ...spec, deferLoading: true });
        add.push({ type: "reference", name: spec.name });
      } else return { kind: "new-epoch", reason: `the tool "${spec.name}" changed its definition, which a reference-only row cannot express` };
      continue;
    }
    if (toolDefinitionKey(have) === toolDefinitionKey(spec)) continue;
    // REDEFINITION: "send a different definition under the same name ... The new definition replaces the
    // earlier one from that position onward" -- no removal first, and it works for a tool `tools` declares.
    if (inline) add.push(definition(spec));
    else return { kind: "new-epoch", reason: `the tool "${spec.name}" changed its definition, which a reference-only row cannot express` };
  }
  add.sort((a, b) => byCodeUnit(a.name, b.name));
  if (declarations.length === 0 && remove.length === 0 && add.length === 0) return { kind: "same" };
  return { kind: "change", change: { declare: declarations, remove, add } };
}

function diffOpenAi(live: readonly ProviderToolSpec[], state: ToolState, caps: ToolChangeCaps): ToolDiff {
  const visible = live.filter((t) => t.deferLoading !== true);
  const add: ToolChangeSet["add"] = [];
  for (const spec of visible) {
    const have = state.available.get(spec.name);
    if (have !== undefined && toolDefinitionKey(have) === toolDefinitionKey(spec)) continue;
    if (caps.additionalTools !== true) return { kind: "new-epoch", reason: `the tool "${spec.name}" is new or changed, and this row documents no \`additional_tools\` item` };
    add.push(definition(spec));
  }
  const visibleNames = new Set(visible.map((t) => t.name));
  const restricted = [...state.available.keys()].some((name) => !visibleNames.has(name));
  if (restricted && caps.allowedTools !== true) return { kind: "new-epoch", reason: "a tool was withdrawn, and this row documents no `allowed_tools` choice" };
  const allowedTools = restricted ? [...visibleNames].sort(byCodeUnit) : undefined;
  const extra = allowedTools !== undefined ? { allowedTools } : {};
  if (add.length === 0) return { kind: "same", ...extra };
  return { kind: "change", change: { declare: [], remove: [], add }, ...extra };
}

function definition(spec: ProviderToolSpec): ToolChangeSet["add"][number] {
  return { type: "definition", name: spec.name, description: spec.description, inputSchema: spec.inputSchema };
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The wire form of one `tool_changes` entry: an empty-content `system` message, or `undefined` when it says nothing. */
export function toolChangesWireMessage(message: ProviderMessage): ProviderMessage | undefined {
  const change = message.meta!.attachment as ToolChangesAttachment;
  if (change.remove.length === 0 && change.add.length === 0) return undefined;
  return { role: "system", content: [], toolChanges: { remove: [...change.remove], add: change.add.map((a) => ({ ...a })) } };
}

/**
 * The deferred tools a `tool_changes` entry of the current epoch surfaced by reference (see
 * `referencedToolNames`). WS-23: with `modelKey`, the current epoch is THAT model's newest (and only its
 * own changes count); without, the history's last epoch of any model -- the pre-WS-23 reading.
 */
export function toolChangeReferences(history: readonly ProviderMessage[], modelKey?: string | null): string[] {
  let from = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (!isToolEpochMessage(message)) continue;
    if (modelKey !== undefined && (message.meta!.attachment as ToolEpochAttachment).modelKey !== modelKey) continue;
    from = i;
    break;
  }
  if (from === -1 && modelKey !== undefined) return [];
  const out: string[] = [];
  let preceding = from >= 0 ? (history[from]!.meta!.attachment as ToolEpochAttachment).modelKey : null;
  const owner = preceding;
  for (let i = from + 1; i < history.length; i++) {
    const message = history[i]!;
    if (isToolEpochMessage(message)) {
      preceding = (message.meta!.attachment as ToolEpochAttachment).modelKey;
      if (modelKey === undefined) break;
      continue;
    }
    if (!isToolChangesMessage(message)) continue;
    const change = message.meta!.attachment as ToolChangesAttachment;
    if (modelKey !== undefined && (change.modelKey !== undefined ? change.modelKey : preceding) !== owner) continue;
    for (const addition of change.add) if (addition.type === "reference") out.push(addition.name);
  }
  return out;
}
