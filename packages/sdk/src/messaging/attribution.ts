// How a delivered message is RENDERED into a receiving session's input, and how the facet's own
// notification bucket is NAMED. Both are published here rather than kept in the Winter runtime for
// the same reason the rest of this subpath is: the router package renders and names the identical
// things for its official branch, and two implementations of "what an attributed turn looks like"
// would diverge the moment either is edited.

/** The tag a rendered turn is wrapped in. One literal, so nothing spells it twice. */
export const AGENT_MESSAGE_TAG = "agent-message";

/**
 * Fix r2 (N2): the escape that makes the attribution frame mean something.
 *
 * THE FINDING. A rendered turn is TEXT in the receiving session's input, and the runtime concatenates
 * sender-chosen text into it. `body` and `summary` are model-authored on the `SendMessage` path
 * (straight off the tool input), so a subagent could close the runtime's frame and open a second one
 * naming an address it does not own with `sender-permission-class="bypasses"` — measured, delivered
 * intact, and syntactically indistinguishable to the receiving model from the real one. The `from`
 * field was never forgeable; the FRAME was, which made the label decorative.
 *
 * WHAT IS ESCAPED, and nothing more: the two sequences that can end or start a frame (`</tag` and
 * `<tag`) and the double quote that can close an attribute value. A real message never contains the
 * first two, and the quote is escaped only inside attribute values, so "a legitimate message arrives
 * altered" costs a bare `"` in a summary and nothing else. The transformation is VISIBLE rather than
 * silent (`&lt;` / `&quot;`), so a receiver reading a message that genuinely discusses this syntax
 * still sees what was written.
 *
 * WHAT IT IS NOT. Lexical escaping makes the count of attributions in a turn honest; it does not make
 * attribution structural. A protocol-level frame kind — where the receiver's DECODER carries the
 * attribution and a body is inert data whatever it contains — is the real fix, and is recorded as a
 * carry. Until then this is what keeps the label from being trivially imitable.
 */
export function escapeAttributionText(value: string): string {
  return value.split(`</${AGENT_MESSAGE_TAG}`).join(`&lt;/${AGENT_MESSAGE_TAG}`).split(`<${AGENT_MESSAGE_TAG}`).join(`&lt;${AGENT_MESSAGE_TAG}`);
}

/** The same, plus the attribute-value quote — for anything interpolated INSIDE the opening tag. */
export function escapeAttributionAttribute(value: string): string {
  return escapeAttributionText(value).split('"').join("&quot;");
}

/**
 * Fix r2 (N5): the queue key the FACET files and drains notifications under, built structurally.
 *
 * DELIBERATELY NOT the bare session id. A session's own model drains `notifications.drain(sessionId)`
 * through its `ReadNotifications` tool, and a drain REMOVES — so one key would have whichever side
 * read first silently eat the other's notices.
 *
 * `RESERVED_NOTIFICATION_KEY_PREFIX` is what makes the namespace a rule rather than a coincidence of
 * string concatenation: a session id that already carries the prefix would otherwise collide back
 * into the model's bucket. Product ids are `s_<hex>` so it cannot happen today, and
 * `isReservedNotificationKey` lets a caller assert it instead of assuming it.
 */
export const RESERVED_NOTIFICATION_KEY_PREFIX = "host:";

export function facetNotificationKey(sessionId: string): string {
  return `${RESERVED_NOTIFICATION_KEY_PREFIX}${sessionId}`;
}

/** True for a key in the facet's reserved namespace — i.e. one the session's own model never drains. */
export function isReservedNotificationKey(key: string): boolean {
  return key.startsWith(RESERVED_NOTIFICATION_KEY_PREFIX);
}
