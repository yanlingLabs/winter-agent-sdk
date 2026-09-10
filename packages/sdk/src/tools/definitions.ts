// WINTER'S FOUR DEFAULT TOOLS, DECLARED ONCE (ruling R-8-1).
//
// A `WinterToolDefinition` is the half of a tool that is the SAME wherever it runs: its bare name,
// the built-in alias key it answers to, what the model is told it does, and the schemas it accepts
// and returns. That is deliberately everything a MODEL can observe and nothing a HOST decides.
//
// NAMES ARE BARE, and the official SDK's built-in name rides beside them in `builtinName`. The two
// hosts spell the registered name differently and must keep doing so: the Winter runtime registers
// the native `SendMessage` plus a server-qualified canonical twin (`mcpToolName(brand, "send_message")`),
// while the router BINDS the definition under the official runtime's own built-in name. A single
// baked-in "name" field would force one host's spelling on the other; a bare name plus an alias key
// lets each derive its own and keeps the pair verifiably the same tool.
//
// RULING P-8, restated because it is the one thing a well-meaning edit will break: no `source`,
// `exposure`, `availability`, `capabilityRequirements`, `disposition` or `deferred` here. Those are
// registry POLICY — the Winter runtime's `resolveDeferral` short-circuits `source: "builtin"` to
// eager unconditionally, so a shared value would silently decide Tool-Search eligibility for both
// hosts from a package neither of them owns.
import {
  NATIVE_ADVISOR_OUTPUT_SCHEMA,
  NATIVE_ADVISOR_SCHEMA,
  NATIVE_LIST_AGENTS_OUTPUT_SCHEMA,
  NATIVE_LIST_AGENTS_SCHEMA,
  NATIVE_READ_NOTIFICATIONS_OUTPUT_SCHEMA,
  NATIVE_READ_NOTIFICATIONS_SCHEMA,
  NATIVE_SEND_MESSAGE_SCHEMA,
  type JsonSchemaObject,
} from "./schemas.ts";

export interface WinterToolDefinition {
  /** The BARE tool name: `send_message`, `list_agents`, `read_notifications`, `advisor`. */
  readonly toolName: string;
  /** The official SDK's built-in name for the same tool — the alias key a host binds under. */
  readonly builtinName?: string;
  readonly description: string;
  /** Tool-Search terms, for a host that defers this tool. Advertised nowhere when it does not. */
  readonly searchHint?: string;
  readonly inputSchema: JsonSchemaObject;
  readonly outputSchema?: JsonSchemaObject;
  readonly annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
    idempotentHint?: boolean;
    title?: string;
  };
  /**
   * What the CALL does, not where the descriptor came from. `advisor` is `"mcp"` because it sends
   * conversation content to a provider in the session's own trust domain (the same class of egress
   * as the worker model's own requests), even though it registers as a bare built-in name.
   */
  readonly permissionClass: "messaging" | "mcp";
}

export const SEND_MESSAGE_DEFINITION: WinterToolDefinition = {
  toolName: "send_message",
  builtinName: "SendMessage",
  description:
    "Resolves `to` against child registry, teammates, live peer registry; steers a running child, resumes an addressable completed/stopped child, wakes an idle live peer, queues for a running peer; never cold-resumes an arbitrary exited transcript.",
  searchHint: "send message agent session peer child steer resume notify idle",
  inputSchema: NATIVE_SEND_MESSAGE_SCHEMA,
  // No pinned outputSchema (WS-10 §10.1): the result "reports success/message and MAY include a
  // message ID, routing/receipt information … or a CLASSIFIED FAILURE" — the typed outcome IS the
  // result, and pinning a shape here would fix a union that is still growing.
  permissionClass: "messaging",
};

export const LIST_AGENTS_DEFINITION: WinterToolDefinition = {
  toolName: "list_agents",
  builtinName: "ListAgents",
  description: "Names/refs, activity/status, addressing identity for children, teammates, eligible live peers; never an enumeration of exited transcripts.",
  searchHint: "list agents sessions peers children roster reachable",
  inputSchema: NATIVE_LIST_AGENTS_SCHEMA,
  outputSchema: NATIVE_LIST_AGENTS_OUTPUT_SCHEMA,
  permissionClass: "messaging",
};

export const READ_NOTIFICATIONS_DEFINITION: WinterToolDefinition = {
  toolName: "read_notifications",
  builtinName: "ReadNotifications",
  description: "Drains Winter's own global-messaging notification queue ([WS-10]) — the idle/exit notices a `notify_when_idle` subscription produced.",
  searchHint: "read notifications drain idle notice queue subscription",
  inputSchema: NATIVE_READ_NOTIFICATIONS_SCHEMA,
  outputSchema: NATIVE_READ_NOTIFICATIONS_OUTPUT_SCHEMA,
  permissionClass: "messaging",
};

export const ADVISOR_DEFINITION: WinterToolDefinition = {
  toolName: "advisor",
  // D29: the built-in name IS the bare name. On the official branch the model already sees
  // Anthropic's own API-side `advisor`, which is also parameterless — so the bare name is what makes
  // the two branches MATCH, and a server-qualified one is what made them differ.
  builtinName: "advisor",
  description:
    "Consults a stronger reviewer model over this session's own conversation/tool history (provider-opaque state such as encrypted_content is never included). Reviewer unavailable/timeout -> ordinary tool error; never blocks the turn.",
  searchHint: "advisor review reviewer second opinion stronger model critique",
  inputSchema: NATIVE_ADVISOR_SCHEMA,
  outputSchema: NATIVE_ADVISOR_OUTPUT_SCHEMA,
  permissionClass: "mcp",
};

/** The four, in the order a host registers them. */
export const WINTER_DEFAULT_TOOL_DEFINITIONS: readonly [typeof SEND_MESSAGE_DEFINITION, typeof LIST_AGENTS_DEFINITION, typeof READ_NOTIFICATIONS_DEFINITION, typeof ADVISOR_DEFINITION] = [
  SEND_MESSAGE_DEFINITION,
  LIST_AGENTS_DEFINITION,
  READ_NOTIFICATIONS_DEFINITION,
  ADVISOR_DEFINITION,
];
