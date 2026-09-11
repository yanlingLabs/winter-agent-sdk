// WHO IS CALLING — shared by the three messaging executors, in a module that REGISTERS NOTHING.
//
// WHY IT IS ITS OWN FILE (SB review r1, Important 2). This function first lived in
// `impl/send-message.ts`, and `list-agents.ts`/`read-notifications.ts` imported it from there. But
// every `impl/*.ts` is side-effectful AT MODULE LOAD by design — it imports its descriptors and
// calls `replaceExecutor` — so importing the ReadNotifications executor also registered
// `SendMessage`, its canonical standing-server twin, and both of their descriptors. That is exactly
// the invisible coupling between leaf files that `descriptors/_shared.ts`'s own header describes
// this architecture as avoiding, and the suite hid it: `descriptors/index.ts` loads everything in
// practice, so nothing ever observed the difference.
//
// This module imports only TYPES (both `import type`, erased at compile time), so it contributes no
// runtime edge at all — the leading underscore matches `descriptors/_shared.ts`'s own convention for
// a shared non-tool file.
import type { WinterToolCaller } from "@yanlinglabs/winter-agent-sdk/tools";

import type { ToolExecutionContext } from "../registry.ts";

/**
 * The caller identity a messaging tool runs AS — from the execution context, never from the
 * arguments. Taking it from the arguments would make the sender's identity something a model could
 * write, and every fence in the messaging core is keyed on it.
 *
 * `ctx.toolUseId` is real (registry.ts threads `EngineToolCall.id` onto every context it builds), so
 * WS-10 §12's retry-stable messageId derivation is live in production. It is passed through as
 * possibly-undefined rather than defaulted here: the SDK's port allocates the fallback, once, for
 * both hosts, and its posture is the one this runtime used to carry — a fresh id per call and NO
 * dedupe, because two distinct model calls must never be mistaken for one retry of each other.
 */
export function callerContextFrom(ctx: ToolExecutionContext): WinterToolCaller {
  return {
    sessionId: ctx.sessionId,
    ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
    ...(ctx.toolUseId !== undefined ? { toolUseId: ctx.toolUseId } : {}),
  };
}
