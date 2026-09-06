// Refusal sentences shared across adapter families.
//
// WS-13 §8.2's rule is that a selection this layer cannot represent is refused BEFORE a request is
// sent. Where two families refuse the same caller mistake, they must say the same thing: a session
// moves between providers, and a caller who reads "carries no budgetTokens, which this endpoint
// requires" on one family and a differently-worded sentence with the same meaning on the next has
// to learn the message twice to recognise the situation once.
//
// The wording lived in three adapters as three literals, kept in step by a comment ("the wording is
// Lane B's") and by a reviewer re-diffing them each round — which is how the Google family ended up
// with a fourth sentence that the whole-branch review found (M-2). A shared constant makes the
// parity structural: there is one string, and a change to it is a change to every family at once.
//
// The family-specific REASON does not live here. It stays in the comment at each refusal site,
// where the endpoint's own behaviour is what explains it: Anthropic and Bedrock reject a budget-less
// enabled config outright, while Google accepts one and quietly serves the model's own default. The
// caller's situation, and the two ways out of it, are the same either way.

/**
 * `thinking: { type: "enabled" }` with no `budgetTokens`, on a family whose reasoning is
 * BUDGET-controlled (Anthropic Messages, Bedrock Converse, Google GenerateContent).
 *
 * The OpenAI family does NOT use this sentence: it has no budget field at all, so the same config
 * resolves against the row's `defaultEffort` and is refused only when there is none — a different
 * situation with a different way out (`THINKING_ENABLED_NEEDS_EFFORT`, in the family's own
 * `shared.ts`, which is where the effort vocabulary lives).
 */
export const THINKING_ENABLED_NEEDS_BUDGET =
  'thinking `{ type: "enabled" }` carries no budgetTokens, which this endpoint requires. Pass `budgetTokens`, or ask for `{ type: "adaptive" }` if the model should decide.';
