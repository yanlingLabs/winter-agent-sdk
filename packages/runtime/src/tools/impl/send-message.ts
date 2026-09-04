// Task 7 (Lane D, WS-10 §10.1): the SendMessage executor. Input validation and summary
// derivation/truncation happen HERE, never in messaging/router.ts (which receives an already-clean
// SendMessageInput) -- this file owns the "malformed call, no messageId" tier; router.ts's own
// sendMessage owns every outcome that DOES get a messageId once the call is well-formed
// (messaging/addressing.ts's own header: "an invalid call never enters the messaging system").
//
// NEEDS_CONTEXT (flagged in the task report; see messaging/router.ts's own header for the full
// citation): `ToolExecutionContext` (registry.ts) carries no per-call tool-use id --
// `EngineToolCall.id` exists but `buildRegistryToolExecutor` never threads it through. Until a spine
// change adds one, every call here allocates a FRESH fallback id -- the safe direction (never
// falsely treating two different model calls as "the same retry"). Genuine retry-idempotency
// (WS-10 §12) is fully correct and fully tested at the router.ts layer against a real, stable
// toolUseId; this file is where a real id needs to start flowing from once the spine gap closes --
// `callerContextFrom` below reads an optional, forward-compatible `toolUseId` field off `ctx` first
// and only falls back when it's absent, so no further change will be needed here at that point.
import "../descriptors/send-message.ts";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { validateToField } from "../../messaging/addressing.ts";
import { getMessagingRuntime, sendMessage, type CallerContext } from "../../messaging/router.ts";

export const SEND_MESSAGE_TOOL_NAME = "SendMessage";

// NEEDS_CONTEXT (mid-task controller note, Lane B review finding; not built by this lane -- see the
// task report): WS-10 §15/WS-14 name a CANONICAL MCP-aliased duplicate of this tool,
// `mcp__winter__send_message` (`Options.toolAliases` redirects the model-visible built-in name
// `SendMessage` to it, WS-09 §10, packages/sdk/src/options.ts). No descriptor for that canonical
// name exists anywhere in this repo yet, and creating one is out of THIS lane's file permissions
// (a new `tools/descriptors/*.ts` entry is T1/T8's own descriptor-authoring territory; the standing
// `winter` MCP server that would host it, `mcp/winter-server.ts`, is R4-10-forbidden to this lane) --
// mirrors mcp/winter-server.ts's own "the other standing-server tools ... are P7/P8 ... owned by
// [WS-14]/[WS-15]; nothing registers them here yet" posture for send_message/list_agents
// specifically. WHOEVER adds that descriptor MUST declare it `deferred: true` at the source: the §10
// duplicate-suppression Lane B built only moves entries between advertised-partition buckets --
// `resolveDeferral`/`isLoadFirstBlocked` (registry.ts) read the descriptor's own declared `deferred`
// field, so an eager canonical entry would vanish from `system/init.tools` (LOOKS deferred) yet
// still resolve eager at the execution boundary (callable by name with no `select:` first) -- a real
// visibility/gating mismatch, not merely a cosmetic duplicate. Declaring it deferred at the source is
// what makes runtime suppression a safety net on top of real deferral, rather than the only guard.

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
