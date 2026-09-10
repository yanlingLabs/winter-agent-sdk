// WS-10 §10.1/§10.2's and WS-06 §4's MODEL-FACING SCHEMAS — one definition, shared by both runtime
// branches.
//
// WHY THIS MODULE EXISTS (ruling R-8-1, and the second duplicate a cross-repo sweep found).
// Three lanes needed the same schema and each wrote its own: the Winter runtime's descriptor files,
// the router package's `src/native-args.ts` (the alias target the model's NATIVE block lands in) and
// its `src/messaging/handlers.ts` (the canonical MCP tool the Winter branch registers). They were
// near-identical — and where they differed, they differed on the model-visible contract. WS-10 §10.1
// says "both runtime branches MUST present this exact model-facing schema", so a second copy is not
// duplication to tidy up: it is the schema drifting between branches, in the one place a test in
// either host alone cannot see.
//
// WINTER OWNS THESE TOOLS (R-8-1). The router owns no tool; it BINDS these under the official SDK's
// built-in names. So the definitions live here, in the package both hosts already depend on, and a
// change to §10.1's rules arrives with the SDK rather than needing to be noticed twice.
//
// NO REGISTRY POLICY FIELDS LIVE HERE (ruling P-8). `source`/`exposure`/`availability`/
// `capabilityRequirements`/`disposition`/`deferred` are each host's own answer — the Winter runtime's
// `resolveDeferral` short-circuits `source: "builtin"` to eager unconditionally, so the value is not
// even portable between them. A shared field would silently decide Tool-Search eligibility for both.

/**
 * The self-describing shape a tool schema is stored and served as.
 *
 * Deliberately structural and permissive rather than a full JSON Schema type: neither host validates
 * model input against these at all (the Winter registry's own type is explicitly "self-describing…
 * not a validator" — the ACCEPTORS in `accept.ts` are what enforce the contract). What matters is
 * that the advertised bytes are one object, in one place.
 */
export interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, unknown>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

/** WS-10 §10.1's bounds. `to`'s own limit is the messaging subpath's; this is the copy the SCHEMA advertises. */
export const SEND_MESSAGE_TO_MAX = 300;
export const SEND_MESSAGE_SUMMARY_MAX = 200;
/** WS-10 §10.2's bound on both reserved `ListAgents` fields. */
export const LIST_AGENTS_FIELD_MAX = 256;

export const NATIVE_SEND_MESSAGE_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    to: { type: "string", maxLength: SEND_MESSAGE_TO_MAX, description: 'no newline, no "*" broadcast' },
    message: { type: "string", description: 'required; defaults "" for pure idle subscription' },
    summary: { type: "string", maxLength: SEND_MESSAGE_SUMMARY_MAX },
    notify_when_idle: { type: "boolean", description: "one-shot; main conversation -> same-machine session only" },
  },
  required: ["to", "message"],
};

export const NATIVE_LIST_AGENTS_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    channel: { type: "string", maxLength: LIST_AGENTS_FIELD_MAX, description: "reserved" },
    q: { type: "string", maxLength: LIST_AGENTS_FIELD_MAX, description: "reserved" },
  },
};

/**
 * WS-10 §10.2: "`ListAgents` output is EXACTLY `{ listing: string }`."
 *
 * "Exactly" is spelled `additionalProperties: false` here, which neither former copy said out loud
 * (both merely listed the one property). It is the whole content of §10.2's sentence, and it is the
 * half a reader of the schema alone would otherwise have to take on trust.
 */
export const NATIVE_LIST_AGENTS_OUTPUT_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: { listing: { type: "string" } },
  required: ["listing"],
  additionalProperties: false,
};

/** WS-06 §3.6: the ordinary call is `{}` and nothing else. */
export const NATIVE_READ_NOTIFICATIONS_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/**
 * The drained PAGE, not one notification: the pinned vendor shape is an ARRAY per call plus what is
 * left behind, so a model that drains knows whether to drain again.
 */
export const NATIVE_READ_NOTIFICATIONS_OUTPUT_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    notifications: {
      type: "array",
      items: {
        type: "object",
        properties: {
          notification_id: { type: "string" },
          origin: { type: "string" },
          queued_at: { type: "string" },
          content: { type: "string" },
        },
      },
    },
    remaining: { type: "number" },
  },
};

/**
 * WS-06 §4: input is `{}` — the runtime forwards the session's own history; no model-supplied
 * parameters.
 *
 * NO `additionalProperties` KEY, DELIBERATELY. Neither host validates model input against a JSON
 * Schema, so the keyword would be decorative — and the posture is applied uniformly across the
 * parameterless tools rather than declared on one and not the others. The ACCEPTOR is where "no
 * more" is actually enforced (ruling P-4), and it is enforced for `read_notifications` too, whose
 * schema does carry the keyword because its pinned vendor shape does.
 */
export const NATIVE_ADVISOR_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {},
};

export const NATIVE_ADVISOR_OUTPUT_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    advice: { type: "string" },
    model: { type: "string" },
    truncated: { type: "boolean" },
  },
  required: ["advice", "model"],
};
