// Task 7 (Lane D, WS-10 §10.1): the SendMessage executor. Input validation and summary
// derivation/truncation happen HERE, never in messaging/router.ts (which receives an already-clean
// SendMessageInput) -- this file owns the "malformed call, no messageId" tier; router.ts's own
// sendMessage owns every outcome that DOES get a messageId once the call is well-formed
// (the messaging subpath's addressing header: "an invalid call never enters the messaging system").
//
// CLOSED by Phase 4 Task 8: `ToolExecutionContext.toolUseId` is real now (registry.ts threads
// `EngineToolCall.id` onto every context it builds), so WS-10 §12's retry-stable messageId
// derivation is live in production, not only at the router layer -- see `callerContextFrom` below.
import "../descriptors/send-message.ts";
import "../descriptors/winter-send-message.ts"; // rider 15: the canonical alias-target descriptor this file also installs an executor for.
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { validateToField } from "@yanlinglabs/winter-agent-sdk/messaging";
import { getMessagingRuntime, sendMessage, type CallerContext } from "../../messaging/router.ts";
import { WINTER_BRAND, mcpToolName } from "@yanlinglabs/winter-agent-sdk";

export const SEND_MESSAGE_TOOL_NAME = "SendMessage";

// CLOSED by Phase 4 Task 8 (rider 15): the canonical standing-server duplicate
// WS-10 §15/WS-14 name now exists -- `descriptors/winter-send-message.ts`, declared `deferred: true`
// AT THE SOURCE exactly as the controller's own mid-task note required, with this file's own
// executor installed under it (see the bottom of this file).
const MAX_SUMMARY_LENGTH = 200; // WS-10 §10.1 verbatim

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

// WS-10 §10.1: "summary?: derived from first message line when absent; truncated when overlong."
// NEVER a validation error -- a computed value, or absent when there is nothing to derive from an
// empty message (the pure-idle-subscription case).
function deriveSummary(rawSummary: string | undefined, message: string): string | undefined {
  if (rawSummary !== undefined) {
    return rawSummary.length > MAX_SUMMARY_LENGTH ? rawSummary.slice(0, MAX_SUMMARY_LENGTH) : rawSummary;
  }
  const firstLine = message.split("\n")[0] ?? "";
  if (firstLine.length === 0) return undefined;
  return firstLine.length > MAX_SUMMARY_LENGTH ? firstLine.slice(0, MAX_SUMMARY_LENGTH) : firstLine;
}

let fallbackCounter = 0;
function fallbackToolUseId(): string {
  return `no-tool-use-id-${++fallbackCounter}-${Date.now()}`;
}

function callerContextFrom(ctx: ToolExecutionContext): CallerContext {
  // Phase 4 Task 8: `ctx.toolUseId` is a REAL ToolExecutionContext field now (registry.ts threads
  // `EngineToolCall.id` onto every context it builds) -- the forward-compatible cast this line used
  // to need is gone. WS-10 §12's "messageId is stable across retries, derived/persisted from the
  // sender session plus tool-call ID" is therefore live in production, not only at the router layer.
  // The synthetic fallback stays for a hand-built context with no id: the SAFE direction, since two
  // distinct model calls must never be mistaken for one retry of each other.
  return {
    sessionId: ctx.sessionId,
    ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
    toolUseId: ctx.toolUseId ?? fallbackToolUseId(),
  };
}

export const sendMessageExecutor: ToolExecutor = {
  async execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    const record = asRecord(input);

    const toCheck = validateToField(record.to);
    if (!toCheck.ok) return { output: `Error: SendMessage input is invalid: ${toCheck.message}`, isError: true };

    if (typeof record.message !== "string") {
      return { output: "Error: SendMessage input is invalid: message must be a string", isError: true };
    }
    if (record.notify_when_idle !== undefined && typeof record.notify_when_idle !== "boolean") {
      return { output: "Error: SendMessage input is invalid: notify_when_idle must be a boolean", isError: true };
    }
    if (record.summary !== undefined && typeof record.summary !== "string") {
      return { output: "Error: SendMessage input is invalid: summary must be a string", isError: true };
    }
    const notifyWhenIdle = record.notify_when_idle === true;
    if (record.message.length === 0 && !notifyWhenIdle) {
      return {
        output: "Error: SendMessage input is invalid: message may only be empty when notify_when_idle is true (a pure idle subscription, WS-10 §10.1)",
        isError: true,
      };
    }

    const runtime = getMessagingRuntime();
    if (runtime === undefined) {
      return { output: "Error: SendMessage has no messaging runtime configured for this session", isError: true };
    }

    const to = record.to as string;
    const message = record.message;
    const summary = deriveSummary(record.summary, message);
    const caller = callerContextFrom(ctx);

    const result = await sendMessage(runtime, caller, {
      to,
      message,
      ...(summary !== undefined ? { summary } : {}),
      ...(record.notify_when_idle !== undefined ? { notify_when_idle: notifyWhenIdle } : {}),
    });

    return { output: JSON.stringify(result) };
  },
};

replaceExecutor(SEND_MESSAGE_TOOL_NAME, sendMessageExecutor);

// Phase 4 Task 8 (rider 15, WS-09 §10 / WS-10 §15): the CANONICAL standing-Winter-server name
// [WS-14]'s official-branch `toolAliases` redirects `SendMessage` to. Registered here, over the
// SAME executor object (never a copy, never a wrapper), because WS-09 §10 requires an alias target
// to "accept the native arguments exactly" -- one implementation is the only way that can never
// drift. RULING P4-E's "there is NO dispatch redirection [on the Winter branch] -- the native
// name's executor is the implementation" is satisfied structurally: both names ARE the same
// executor, so nothing needs to redirect. The descriptor (descriptors/winter-send-message.ts,
// `deferred: true` at the source) is what keeps the model from normally seeing both.
export const WINTER_CANONICAL_SEND_MESSAGE_TOOL_NAME = mcpToolName(WINTER_BRAND, "send_message");
replaceExecutor(WINTER_CANONICAL_SEND_MESSAGE_TOOL_NAME, sendMessageExecutor);
