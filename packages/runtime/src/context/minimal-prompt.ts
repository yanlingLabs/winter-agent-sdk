// Phase 5 Lane C (task 6) -- R5-9's authored MINIMAL prompt: what `systemPrompt: undefined` gets.
//
// WS-11 §6.1 is explicit that this is NOT the full product preset, and that the difference from a
// CLI's own default is deliberate: an SDK caller who configured no prompt gets an agent that knows
// how to call tools and nothing else, so their own instructions are the only voice in the room.
// Anything beyond tool-calling mechanics -- tone, task posture, memory, environment -- belongs to
// the `winter_code` preset, which a caller has to ask for.
//
// RULING R5-16 puts the only copy of this text HERE, never in the engine: with no assembler
// registered the engine sends no system prompt at all and authors no fallback. Two copies of an
// authored prompt is the exact failure the P5 spine exists to prevent -- nothing fails to compile
// when they disagree, and the divergence shows up only in a live request.

/** R5-9's ceiling. Asserted, not aspirational -- a "minimal" prompt that grew is no longer minimal. */
export const MINIMAL_PROMPT_MAX_LINES = 20;

/** Bump on any edit to the text below. Reported as `AssembledPrompt.presetVersion`. */
export const MINIMAL_PROMPT_VERSION = "winter_minimal@1";

export const MINIMAL_PROMPT = [
  "You are an agent that completes the caller's task by calling tools.",
  "",
  "Work from what the tools tell you, not from assumption: read a file before editing it, and confirm a value before building on it.",
  "Fill every required argument from something you actually know. If a required value is unknown, find it with another tool rather than inventing it.",
  "Issue independent calls together and dependent calls in order.",
  "Read what a tool returns, including its errors: an error describes the world, so adjust rather than repeating an identical failing call.",
  "Never report an action you did not take with a tool, or a result you have not seen.",
  "When the task is done, stop calling tools and answer.",
].join("\n");
