// Phase 6 Lane C: the two DOORS a foreign model's readable reasoning may enter a target through.
//
// R6-8, stated once because everything here is downstream of it: a foreign summary or exposed
// reasoning is NEVER written into a signed thinking channel. Capture (F) settled why -- the pinned
// runtime never emits or replays a thinking block without a `signature` key, materialising `""` when
// the stream carries none -- so a foreign summary placed in `assistant.message.content` as a
// `thinking` block would go on the wire carrying a fabricated signature, which is impersonation of
// the producing provider's own attestation. There are therefore exactly two doors, and neither is a
// validated channel:
//
//   1. the TAG door -- `<recovered_reasoning_summary provider="…" model="…">…</recovered_reasoning_summary>`
//      as ORDINARY TEXT inside the target's own message -- for hidden-reasoning targets (Anthropic,
//      Gemini-3, any model whose reasoning channel validates what it is given). Text is the only door
//      into those families;
//   2. the THINKING-CHANNEL door -- the target's own PLAIN-TEXT reasoning channel, with the origin
//      named inside the text -- for exposed-reasoning targets, whose channel carries no signature to
//      forge.
//
// Both doors label the content as another model's, and neither presents it as instruction. That is
// the injection floor (§9.3): quoted content is DATA from a previous model, never a user command and
// never system authority.

/** Which door a decoration goes through. Mirrors `ProviderMessageLike.decoration.door`. */
export type DecorationDoor = "tag" | "thinking-channel";

/** The tag name of the text door, in ONE place: the renderer, the corpus and the escaping all name it from here. */
export const RECOVERED_REASONING_TAG = "recovered_reasoning_summary";

/** Who produced the reasoning being carried. Ids only -- never a credential, never opaque state. */
export interface DecorationSource {
  providerId: string;
  modelKey: string;
}

export interface DecorationInput {
  /** The readable material: a provider-produced SUMMARY or complete exposed reasoning. Never opaque state -- there is deliberately no parameter for one. */
  text: string;
  source: DecorationSource;
  door: DecorationDoor;
  /** §9.6's context budget for this one decoration. Absent means unbounded (the caller has already decided it fits). */
  maxChars?: number;
}

export interface Decoration {
  text: string;
  door: DecorationDoor;
  /** §9.6: ANY truncation flips the transfer to warned-lossy. The flag is what makes that flip observable rather than a silent claim of losslessness. */
  truncated: boolean;
}

/**
 * Which door a target's own reasoning transport admits.
 *
 * `full-exposed` targets read plain reasoning text, so their own channel is available. `summary` and
 * `none` targets either validate their reasoning channel (Anthropic signatures) or have none at all;
 * for both, the text tag is the only door.
 */
export function doorFor(target: { readableState: "none" | "summary" | "full-exposed" }): DecorationDoor {
  return target.readableState === "full-exposed" ? "thinking-channel" : "tag";
}

/**
 * Builds ONE decoration.
 *
 * The escaping below is not cosmetic. `providerId`/`modelKey` are catalog strings and a summary is
 * MODEL-GENERATED text: both are untrusted (WS-13 §7 says as much about model ids), and either could
 * contain a forged closing delimiter. A body that could terminate its own wrapper would let quoted
 * prior-model text escape the delimiter and read as first-class instruction to the target -- the one
 * failure the injection floor exists to prevent -- so a forged delimiter is neutralised into inert
 * text and the wrapper's own closing tag remains the only one.
 */
export function buildDecoration(input: DecorationInput): Decoration {
  const { text, truncated } = trimToBudget(input.text, input.maxChars);
  const body = neutralizeDelimiters(text);
  if (input.door === "tag") {
    const provider = escapeAttribute(input.source.providerId);
    const model = escapeAttribute(input.source.modelKey);
    return {
      text: `<${RECOVERED_REASONING_TAG} provider="${provider}" model="${model}">${body}</${RECOVERED_REASONING_TAG}>`,
      door: "tag",
      truncated,
    };
  }
  // The thinking-channel door NAMES THE ORIGIN INSIDE THE TEXT (WS-13 §8.2's own wording). Without
  // it, the target's reasoning channel would carry another model's reasoning with nothing marking it
  // as another model's -- indistinguishable from its own, which is the merge §9.5 forbids.
  return {
    text: `[prior-model reasoning, carried as data — provider: ${escapeInline(input.source.providerId)}, model: ${escapeInline(input.source.modelKey)}]\n${body}`,
    door: "thinking-channel",
    truncated,
  };
}

/**
 * §9.6's trimming, mechanically.
 *
 * KEEPS THE HEAD AND THE TAIL with an explicit elision between them. §9.6 orders what to retain by
 * MEANING (concrete decisions, evidence, exact identifiers and pending work before redundant
 * speculation), and Winter cannot rank text semantically without another model call -- so this is an
 * approximation, chosen because objective and evidence cluster at the start of a reasoning trace and
 * decisions and pending work at the end, while restatement accumulates in the middle. The
 * approximation is only defensible because it is NEVER silent: `truncated` flips the whole transfer
 * to warned-lossy, which is §9.6's closing rule ("never silently truncate reasoning while still
 * classifying the handoff as lossless").
 */
export function trimToBudget(text: string, maxChars: number | undefined): { text: string; truncated: boolean } {
  if (maxChars === undefined || text.length <= maxChars) return { text, truncated: false };
  const marker = "\n[…prior-model reasoning trimmed to fit the target context…]\n";
  if (maxChars <= marker.length) {
    // No room for both halves and the marker: keep the TAIL, which is where decisions and pending
    // work are, and say so.
    return { text: `${marker}${text.slice(Math.max(0, text.length - Math.max(0, maxChars - marker.length)))}`, truncated: true };
  }
  const budget = maxChars - marker.length;
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  return { text: `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(text.length - tail) : ""}`, truncated: true };
}

/** Escapes an XML-ish attribute value. `&` first, or the escapes escape each other. */
export function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Strips angle brackets from an id rendered inline in prose, so a crafted model id cannot open a tag of its own. */
export function escapeInline(value: string): string {
  return value.replace(/[<>]/g, "");
}

/**
 * Neutralises any sequence that would look like this module's own delimiter.
 *
 * Only the delimiter is touched -- the body is otherwise carried VERBATIM, because the whole value of
 * forwarding complete exposed reasoning (the DeepSeek→OpenAI no-warning case, §8.4 condition 2) is
 * that it is passed unmodified. Escaping every `<` would modify it, and would then have to be
 * declared lossy.
 */
export function neutralizeDelimiters(text: string): string {
  return text.replace(new RegExp(`<(/?)${RECOVERED_REASONING_TAG}`, "g"), "&lt;$1" + RECOVERED_REASONING_TAG);
}
