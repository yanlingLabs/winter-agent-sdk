// WS-06 §4's `advisor` — the Winter-only capability, as a handler factory both hosts build (P-6).
//
// WHAT MOVED HERE AND WHAT DID NOT. The factory, the narrow reviewer types, the opaque-state floor
// and the transcript assembler are the same on every host, so they live here. REVIEWER RESOLUTION
// does not: which model reviews, and by what precedence, is a provider-layer decision the host owns
// (D30's precedence, its per-family default, and the live model key a `set_model` moves). The host
// hands in a `ReviewerResolver` and keeps the policy.
//
// THE REVIEWER TYPES ARE DELIBERATELY NARROW. The Winter runtime's own `Provider` carries the
// engine's wire types (structured `ContentBlock[]` content, a tool-role message shape, streaming);
// the advisor needs exactly one thing of a provider — turn these messages into one text turn — and
// taking the host's whole interface would drag the engine into a published package and make any
// other host implement it. A host whose provider is not assignable writes a three-line adapter on
// ITS side; this type is never widened to accommodate one.
import { WinterCompatibilitySessionStore } from "../store/session-store.ts";
import type { SessionKey, SessionStore, SessionStoreEntry } from "../store/session-store.ts";
import { resolveWinterHome } from "../paths/home.ts";

import type { WinterToolHandler, WinterToolResult } from "./messaging-handlers.ts";

/**
 * One raw entry of a session's transcript — deliberately narrower/speech-shaped (who said what) than
 * any host's own provider message type, which additionally carries structured content blocks for
 * wire purposes this assembler has no need of.
 */
export interface TranscriptEntry {
  role: "user" | "assistant" | "tool";
  text: string;
}

/**
 * `getEntries` may be SYNCHRONOUS or async. The Winter runtime's real source is a live in-memory
 * array captured by reference from the round loop (synchronous, and it must stay that way — a
 * snapshot taken at wiring time would be empty forever); a host reading a durable transcript off
 * disk needs the promise. The union is what lets one factory serve both.
 */
export interface TranscriptSource {
  getEntries(): TranscriptEntry[] | Promise<TranscriptEntry[]>;
}

export interface AdvisorReviewerRequest {
  messages: ReadonlyArray<{ role: "user" | "assistant" | "tool"; content: string }>;
}

export interface AdvisorReviewerTurn {
  kind: string;
  text?: string;
}

export interface AdvisorReviewer {
  generate(input: AdvisorReviewerRequest): Promise<AdvisorReviewerTurn>;
}

/**
 * Resolves BOTH the provider to call and the model id the result must report, TOGETHER: WS-06 §4's
 * result shape pins `model: string` as required, but a provider interface has no `model` field to
 * read back — whatever backs the reviewer capability must hand back the model id alongside the
 * provider instance it resolved, in ONE seam, rather than two seams that could disagree.
 */
export interface ResolvedReviewer {
  provider: AdvisorReviewer;
  model: string;
}

/** `undefined` is the "no reviewer resolvable" case — WS-06 §4's ordinary tool error, never a throw. */
export type ReviewerResolver = () => ResolvedReviewer | undefined;

export interface AdvisorToolDeps {
  transcriptSource: TranscriptSource;
  resolveReviewer: ReviewerResolver;
  /** Injectable so a host can pin the truncation boundary without a multi-KB fixture transcript. */
  maxChars?: number;
}

export const ADVISOR_DEFAULT_MAX_CHARS = 20_000;

/**
 * RULING R3-3: "the assembler enforces the enforceable floor now — provider-opaque state
 * (encrypted_content, signatures, reasoning items) is NEVER included."
 *
 * `thinking` and `redacted_thinking` are in the list because a probe fed both to a scripted reviewer
 * as literal transcript text and both reached the wire verbatim, payload included, while the
 * original three were correctly stripped. WS-06 §4's constraint reads "provider-opaque state", not
 * "these three keys", and `redacted_thinking.data` is opaque by name.
 *
 * THE COST IS REAL AND ACCEPTED: "thinking" is an ordinary English word, so a review line that
 * merely USES it ("I was thinking about the schema") is dropped along with the ones that carry a
 * key. That is this function's declared posture — drop the whole line, never partially redact, fail
 * toward the reviewer seeing less — and the price is one line of context in an advisory channel
 * against a class of leak the transcript has no other guard for.
 */
export const OPAQUE_MARKERS = ["encrypted_content", "reasoning_item", "signature", "thinking", "redacted_thinking"] as const;

export function stripOpaqueMarkers(text: string): string {
  // Line-oriented and conservative: a whole line mentioning a marker key is DROPPED, never partially
  // redacted — a review channel should fail toward "the reviewer sees less" rather than "the reviewer
  // sees a mangled fragment of something sensitive." Case-insensitive since the keys this guards
  // against get re-cased across providers/SDKs.
  return text
    .split("\n")
    .filter((line) => !OPAQUE_MARKERS.some((marker) => line.toLowerCase().includes(marker)))
    .join("\n");
}

/**
 * Keeps the transcript TAIL (recent turns are what advice needs) and reports `truncated: true` only
 * when something was actually clipped. Opaque-marker stripping runs PER ENTRY before truncation is
 * measured, so a kept entry is always a whole, already-cleaned entry — truncation never bisects one,
 * and a 4-KB `signature:` line never evicts the real conversation that came before it.
 */
export function assembleReviewerMessages(
  entries: readonly TranscriptEntry[],
  maxChars: number = ADVISOR_DEFAULT_MAX_CHARS,
): { messages: Array<{ role: "user" | "assistant" | "tool"; content: string }>; truncated: boolean } {
  const cleaned = entries.map((e) => ({ role: e.role, text: stripOpaqueMarkers(e.text) }));
  const kept: typeof cleaned = [];
  let total = 0;
  let truncated = false;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    const entry = cleaned[i];
    if (!entry) continue;
    if (total + entry.text.length > maxChars) {
      if (kept.length === 0) {
        // The single most-recent entry ALONE exceeds the budget — keep it clipped to its own
        // tail-most `maxChars` characters rather than sending the reviewer nothing at all. Once this
        // fires the budget is fully spent by construction, so stopping here is correct either way.
        kept.unshift({ role: entry.role, text: entry.text.slice(Math.max(0, entry.text.length - maxChars)) });
      }
      truncated = true;
      break;
    }
    kept.unshift(entry);
    total += entry.text.length;
  }
  return { messages: kept.map((e) => ({ role: e.role, content: e.text })), truncated };
}

function error(body: string): WinterToolResult {
  return { text: body, isError: true };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * NO CACHE (WS-06 §4's closing line: "the advisor and the auto-mode classifier are separate routes
 * and MUST NOT share a verdict cache"). Every call re-resolves the reviewer, re-assembles the
 * transcript, and re-generates from scratch; nothing in this module is memoized, so there is nothing
 * here that COULD be shared with a classifier's verdict cache even by accident.
 */
export function createAdvisorToolHandler(deps: AdvisorToolDeps): WinterToolHandler {
  return async (): Promise<WinterToolResult> => {
    let reviewer: ResolvedReviewer | undefined;
    try {
      reviewer = deps.resolveReviewer();
    } catch (err) {
      return error(`Error: advisor failed to resolve a reviewer model: ${describe(err)}`);
    }
    if (!reviewer) {
      return error(
        'Error: advisor is unavailable -- no reviewer model is resolvable in this session\'s provider catalog (WS-06 §4: "Reviewer unavailable/timeout -> ordinary tool error; never blocks the turn").',
      );
    }

    let entries: TranscriptEntry[];
    try {
      entries = await deps.transcriptSource.getEntries();
    } catch (err) {
      return error(`Error: advisor failed to assemble the session transcript: ${describe(err)}`);
    }
    const { messages, truncated } = assembleReviewerMessages(entries, deps.maxChars ?? ADVISOR_DEFAULT_MAX_CHARS);

    let turn: AdvisorReviewerTurn;
    try {
      turn = await reviewer.provider.generate({ messages });
    } catch (err) {
      return error(`Error: advisor's reviewer model failed: ${describe(err)}`);
    }

    if (turn.kind !== "text" || typeof turn.text !== "string") {
      // The advisor is a single-shot review channel with no tool-execution loop of its own (WS-06
      // §4's input is `{}` — there is nothing for a reviewer to call a tool WITH even if it tried).
      // A non-text turn means the resolved reviewer either ignored the absence of a tools array or is
      // wired to the wrong kind of provider — surfaced as an ordinary tool error rather than
      // attempting to dispatch calls this path was never built to execute.
      return error(`Error: advisor's reviewer model returned a non-text response (kind: "${turn.kind}"); advisor has no tool-execution loop to act on it.`);
    }

    return { text: JSON.stringify({ advice: turn.text, model: reviewer.model, ...(truncated ? { truncated: true } : {}) }) };
  };
}

// --- the durable transcript, read as entries (ruling P-6) ----------------------------------------

function entryText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((block) => {
    if (typeof block !== "object" || block === null) return [];
    const record = block as { type?: unknown; text?: unknown };
    return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  });
  return parts.length === 0 ? undefined : parts.join("\n");
}

function toTranscriptEntry(entry: SessionStoreEntry): TranscriptEntry | undefined {
  // ONLY what a reviewer can read. The store's own entry union is open (`type: string` plus an index
  // signature) and carries plenty that is not conversation at all — agent metadata, compaction
  // boundaries, provider-state records. An allowlist by role is the safe direction: a new
  // non-conversational entry type is skipped by construction rather than forwarded because nobody
  // remembered to exclude it.
  if (entry.type !== "user" && entry.type !== "assistant") return undefined;
  const message = entry["message"];
  if (typeof message !== "object" || message === null) return undefined;
  const text = entryText((message as { content?: unknown }).content);
  if (text === undefined || text.length === 0) return undefined;
  return { role: entry.type, text };
}

/**
 * A `TranscriptSource` over the DURABLE transcript of one session.
 *
 * For a host that does not hold the live turn array — the router package, or any consumer wiring the
 * advisor outside an engine's own closure. The Winter runtime keeps its in-memory source (the live
 * `messages` array, captured by reference), because a resumed session's file and its live turns are
 * not the same conversation until the turn ends.
 *
 * Reads through the pinned `SessionStore` interface so a host may inject an in-memory one; the
 * default is the filesystem store over the resolved Winter home. A missing transcript is NO ENTRIES,
 * never a throw: the advisor's whole posture is that an unavailable reviewer context degrades to an
 * ordinary tool error rather than blocking the turn.
 */
export function transcriptSourceForSessionKey(key: SessionKey, opts: { store?: SessionStore; winterHome?: string } = {}): TranscriptSource {
  const store = opts.store ?? new WinterCompatibilitySessionStore({ winterHome: opts.winterHome ?? resolveWinterHome() });
  return {
    async getEntries(): Promise<TranscriptEntry[]> {
      const entries = await store.load(key);
      if (entries === null) return [];
      return entries.flatMap((entry) => {
        const mapped = toTranscriptEntry(entry);
        return mapped === undefined ? [] : [mapped];
      });
    },
  };
}
