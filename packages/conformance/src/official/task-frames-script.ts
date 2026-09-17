// Phase (2026-09-17 sdk-taskframes-parity): the ONE script both runtimes are driven through, and
// the ONE normalization/reduction pipeline both captured traces are run through before comparison.
//
// Contract: the five `system/*` task frames -- task_started, task_progress, task_updated,
// task_notification, background_tasks_changed -- must match the pinned `claude` binary's field
// shapes and wire spellings for Bash (foreground + background) and Agent (foreground, with a
// child that itself calls Bash).
//
// Everything in this file is DRIVER-AGNOSTIC: `decideStep` takes a generic {role, content}[]
// history (both the pinned binary's Anthropic-wire JSON and Winter's own ProviderMessage[] satisfy
// the same shape at the fields this reads -- `content[].type`, `.tool_use_id`, `.text`), so the SAME
// function decides the SAME next step on both sides. Each driver (the test file) turns a Step into
// its own wire/ProviderTurn shape; the routing DECISION itself is never duplicated.

// --- Fixed identifiers, shared verbatim by both drivers ------------------------------------------

export const TOOL_USE_BG = "toolu_bg1";
export const TOOL_USE_FG = "toolu_fg2";
export const TOOL_USE_AGENT = "toolu_agent3";
export const TOOL_USE_CHILD_ECHO = "toolu_child_echo";

export const BG_COMMAND = "sleep 1; exit 3";
export const FG_COMMAND = "sleep 3";
export const BG_DESCRIPTION = "bg fail";
export const FG_DESCRIPTION = "fg sleep";
export const AGENT_DESCRIPTION = "child probe";
export const CHILD_PROMPT = "run echo";
export const SUBAGENT_TYPE = "general-purpose";
export const CHILD_ECHO_COMMAND = "echo hi";

export const PARENT_FINAL_TEXT = "parent: all done";
export const CHILD_FINAL_TEXT = "child: echo done";
export const FALLBACK_TEXT = "ack";

// --- The shared routing decision ------------------------------------------------------------------

export type Step = "bg-call" | "fg-call" | "agent-call" | "agent-final" | "child-echo" | "child-final" | "fallback";

export interface GenericBlock {
  type?: unknown;
  tool_use_id?: unknown;
  text?: unknown;
  [k: string]: unknown;
}
export interface GenericMessage {
  role?: unknown;
  content?: unknown;
  [k: string]: unknown;
}

/** True iff ANY message carries a `tool_result` content block whose `tool_use_id` matches. Never a
 *  text/string search -- both wire shapes (Anthropic JSON, Winter's ContentBlock[]) structurally
 *  agree on this field, so walking it is exact where string-matching a stringified body is not. */
export function hasToolResultFor(messages: readonly GenericMessage[], id: string): boolean {
  for (const m of messages) {
    const content = m.content;
    if (!Array.isArray(content)) continue;
    for (const raw of content as unknown[]) {
      const block = raw as GenericBlock;
      if (block && block.type === "tool_result" && block.tool_use_id === id) return true;
    }
  }
  return false;
}

/** True iff the FIRST `role: "user"` message's text contains `marker` -- the child's own
 *  conversation is discriminated by its first turn carrying the Agent call's `prompt` verbatim (on
 *  the official side it arrives wrapped in the runtime's own injected system-reminders, so this is
 *  a substring check on the first user turn only, never a full-conversation scan -- provider/mock.ts's
 *  own "subagent" case uses the identical discipline for the identical reason). */
export function firstUserTextIncludes(messages: readonly GenericMessage[], marker: string): boolean {
  const first = messages.find((m) => m.role === "user");
  if (!first) return false;
  const content = first.content;
  if (typeof content === "string") return content.includes(marker);
  if (Array.isArray(content)) {
    return (content as unknown[]).some((raw) => {
      const block = raw as GenericBlock;
      return typeof block.text === "string" && block.text.includes(marker);
    });
  }
  return false;
}

/**
 * The shared decision, one call per generate()/loopback request. Mirrors exactly the sequence
 * validated against the real pinned binary (see the task report): the CHILD's own conversation is
 * checked first (its first user turn carries the child prompt verbatim, regardless of how many
 * parent turns preceded it), then the PARENT's conversation is walked backward through its own
 * scripted tool_use ids -- agent3's result means the whole script is done; fg2's result means it is
 * time to spawn the agent; bg1's result means it is time for the foreground sleep; a single-message
 * history means this is the very first turn. Anything else (e.g. the official runtime relaying a
 * background-task notification to the model as an extra turn) falls through to a plain short reply.
 */
export function decideStep(messages: readonly GenericMessage[]): Step {
  if (firstUserTextIncludes(messages, CHILD_PROMPT)) {
    return hasToolResultFor(messages, TOOL_USE_CHILD_ECHO) ? "child-final" : "child-echo";
  }
  if (hasToolResultFor(messages, TOOL_USE_AGENT)) return "agent-final";
  if (hasToolResultFor(messages, TOOL_USE_FG)) return "agent-call";
  if (hasToolResultFor(messages, TOOL_USE_BG)) return "fg-call";
  if (messages.length === 1) return "bg-call";
  return "fallback";
}

// --- Normalization + STRUCTURE/background_tasks_changed/TEXT projection --------------------------

export const TASK_FRAME_SUBTYPES = new Set(["task_started", "task_progress", "task_updated", "task_notification", "background_tasks_changed"]);

export type RawFrame = Record<string, unknown>;

/** By-first-appearance task-id -> "T1"/"T2"/... labeler. One instance per captured trace (each side
 *  gets its OWN label numbering from its OWN real, runtime-generated ids -- the whole point of the
 *  relabel is to make two independently-minted id spaces comparable). */
function makeLabeler(): (id: string) => string {
  const map = new Map<string, string>();
  let n = 0;
  return (id: string): string => {
    let label = map.get(id);
    if (label === undefined) {
      label = `T${++n}`;
      map.set(id, label);
    }
    return label;
  };
}

function normalizeFrame(raw: RawFrame, label: (id: string) => string): RawFrame {
  const out: RawFrame = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "uuid" || k === "session_id") continue; // dropped, never compared
    out[k] = v;
  }
  if (typeof out.task_id === "string") out.task_id = label(out.task_id);
  if (Array.isArray(out.tasks)) {
    out.tasks = (out.tasks as unknown[]).map((entryRaw) => {
      if (entryRaw && typeof entryRaw === "object") {
        const entry: RawFrame = { ...(entryRaw as RawFrame) };
        if (typeof entry.task_id === "string") entry.task_id = label(entry.task_id);
        return entry;
      }
      return entryRaw;
    });
  }
  if (out.patch && typeof out.patch === "object") {
    const patch: RawFrame = { ...(out.patch as RawFrame) };
    if ("end_time" in patch) patch.end_time = "<number>";
    if ("total_paused_ms" in patch) patch.total_paused_ms = "<number>";
    out.patch = patch;
  }
  if (out.usage && typeof out.usage === "object") {
    const usage: RawFrame = { ...(out.usage as RawFrame) };
    for (const k of Object.keys(usage)) usage[k] = "<number>";
    out.usage = usage;
  }
  if (typeof out.output_file === "string" && out.output_file.length > 0) out.output_file = "<path>";
  return out;
}

/** The STRUCTURE assertion's own per-frame reduction: {subtype, task, keys, status, task_type,
 *  is_backgrounded, patchKeys/patchStatus, last_tool_name, subagent_type} -- `keys` (the frame's OWN
 *  sorted top-level key list, post uuid/session_id drop) is what catches a field Winter fails to
 *  emit at all, without this file having to hand-enumerate every field per frame kind. */
export interface ReducedFrame {
  subtype: string;
  task: unknown;
  keys: string[];
  status?: unknown;
  task_type?: unknown;
  is_backgrounded?: unknown;
  patchKeys?: string[];
  patchStatus?: unknown;
  last_tool_name?: unknown;
  subagent_type?: unknown;
}

function reduceFrame(f: RawFrame): ReducedFrame {
  const out: ReducedFrame = {
    subtype: String(f.subtype),
    task: f.task_id,
    keys: Object.keys(f).sort(),
  };
  if ("status" in f) out.status = f.status;
  if ("task_type" in f) out.task_type = f.task_type;
  if ("is_backgrounded" in f) out.is_backgrounded = f.is_backgrounded;
  if (f.patch && typeof f.patch === "object") {
    const patch = f.patch as RawFrame;
    out.patchKeys = Object.keys(patch).sort();
    if ("status" in patch) out.patchStatus = patch.status;
  }
  if ("last_tool_name" in f) out.last_tool_name = f.last_tool_name;
  if ("subagent_type" in f) out.subagent_type = f.subagent_type;
  return out;
}

export interface BgSnapshotEntry {
  task: unknown;
  task_type: unknown;
  ambient?: unknown;
}

export interface TextEntry {
  subtype: string;
  task: string;
  field: "description" | "summary" | "prompt";
  value: string;
}

export interface NormalizedProjection {
  /** Every raw frame kept (system/task_*), normalized, in original emission order -- for the "print
   *  the full normalized sequence" requirement. */
  normalized: RawFrame[];
  structure: ReducedFrame[];
  bgSnapshots: BgSnapshotEntry[][];
  textEntries: TextEntry[];
}

function dedupeAdjacent<T>(items: T[]): T[] {
  const out: T[] = [];
  let prev: string | undefined;
  for (const item of items) {
    const key = JSON.stringify(item);
    if (key !== prev) out.push(item);
    prev = key;
  }
  return out;
}

/** Filters to the five task-frame subtypes, normalizes (drop uuid/session_id, relabel task ids,
 *  scrub numeric usage/patch.end_time/patch.total_paused_ms, scrub a non-empty output_file), and
 *  projects into the STRUCTURE sequence, the distinct background_tasks_changed snapshots, and the
 *  TEXT entries (description/summary/prompt, kept verbatim, printed but never asserted). */
export function normalizeAndProject(rawFrames: readonly RawFrame[]): NormalizedProjection {
  const label = makeLabeler();
  const normalized = rawFrames
    .filter((f) => f.type === "system" && typeof f.subtype === "string" && TASK_FRAME_SUBTYPES.has(f.subtype as string))
    .map((f) => normalizeFrame(f, label));

  const structure = normalized.filter((f) => f.subtype !== "background_tasks_changed").map(reduceFrame);

  const rawBgSnapshots: BgSnapshotEntry[][] = normalized
    .filter((f) => f.subtype === "background_tasks_changed")
    .map((f) => {
      const tasks = Array.isArray(f.tasks) ? (f.tasks as RawFrame[]) : [];
      return tasks.map((e) => ({
        task: e.task_id,
        task_type: e.task_type,
        ...(e.ambient !== undefined ? { ambient: e.ambient } : {}),
      }));
    });
  const bgSnapshots = dedupeAdjacent(rawBgSnapshots);

  const textEntries: TextEntry[] = [];
  for (const f of normalized) {
    for (const field of ["description", "summary", "prompt"] as const) {
      if (typeof f[field] === "string") textEntries.push({ subtype: String(f.subtype), task: String(f.task_id ?? ""), field, value: f[field] as string });
    }
    if (f.subtype === "background_tasks_changed" && Array.isArray(f.tasks)) {
      for (const e of f.tasks as RawFrame[]) {
        if (typeof e.description === "string") {
          textEntries.push({ subtype: "background_tasks_changed", task: String(e.task_id ?? ""), field: "description", value: e.description });
        }
      }
    }
  }

  return { normalized, structure, bgSnapshots, textEntries };
}

// --- Printing helpers (report-only; never used by the assertion itself) --------------------------

export function formatTextEntries(label: string, entries: readonly TextEntry[]): string {
  if (entries.length === 0) return `${label}: (none)`;
  return [`${label}:`, ...entries.map((e) => `  ${e.task}/${e.subtype}.${e.field} = ${JSON.stringify(e.value)}`)].join("\n");
}

/** A key-aligned side-by-side text diff over TextEntry lists, keyed by task+subtype+field (both
 *  sides' task labels are independently minted by normalizeAndProject, but the SAME script produces
 *  the SAME task ORDER on both sides -- see the task report -- so same-position labels line up). */
export function diffTextEntries(officialEntries: readonly TextEntry[], winterEntries: readonly TextEntry[]): string {
  const key = (e: TextEntry): string => `${e.task}|${e.subtype}|${e.field}`;
  const officialMap = new Map(officialEntries.map((e) => [key(e), e.value]));
  const winterMap = new Map(winterEntries.map((e) => [key(e), e.value]));
  const keys = [...new Set([...officialMap.keys(), ...winterMap.keys()])].sort();
  const lines: string[] = [];
  for (const k of keys) {
    const o = officialMap.get(k);
    const w = winterMap.get(k);
    const marker = o === w ? "=" : "≠";
    lines.push(`  [${marker}] ${k}\n      official: ${o === undefined ? "(absent)" : JSON.stringify(o)}\n      winter:   ${w === undefined ? "(absent)" : JSON.stringify(w)}`);
  }
  return lines.length === 0 ? "(no description/summary/prompt text on either side)" : lines.join("\n");
}
