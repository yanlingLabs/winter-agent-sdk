// WS-06 §3.3 "PushNotification" -- the real executor, LOCAL HALF ONLY (Phase 3, Lane D / Task 6).
// Registers over the stub descriptor descriptors/push-notification.ts already in the registry.
// disposition: winter-backed-equivalent -- Winter implements the local desktop notification now; the
// phone-push half rides Winter's own device transport once [WS-15] ships it. Same schema, same
// result fields either way; `disabledReason` is the pinned, permanent way this executor reports "the
// push half doesn't exist yet" (not a transient/retryable condition from THIS tool's own point of
// view -- WS-15 is a separate phase's delivery).
//
// Injectable notifier (task-6 brief, verbatim): "the executor takes an injectable notifier, tests use
// a spy, the default is a no-op stub." Mirrors background-tasks.ts's own
// configure-once-at-engine-startup / reset-for-test singleton shape -- ToolExecutionContext
// (registry.ts, frozen -- this lane may not touch it) has no `notify` field of its own (unlike the
// retired Norma engine's `ctx.notify` bridge), so the seam lives here, module-local, exactly like
// createBackgroundTask's own root resolver.
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
// Self-sufficiency (Lane A precedent, read.ts): see task-graph.ts's identical comment.
import "../descriptors/index.ts";

const MAX_MESSAGE_LENGTH = 199; // WS-06 §3.3: "message <200 chars" -- matches the descriptor's own maxLength: 199.
// P7a fix wave (item 5, M-1 trivia): the reason is MODEL-FACING and named the product. WS-15's
// device transport is nobody's brand in particular until it exists, so the sentence describes the
// thing that is missing rather than whose it would be.
const DISABLED_REASON = "push transport unconfigured";

export type PushNotifier = (message: string) => void;

// No-op by default: WS-15's Winter device transport does not exist yet, and the task-6 brief is
// explicit that this phase must "do NOT attempt real notifications in tests." A real host (the
// daemon, once it exists) calls configurePushNotifier with something that actually raises a macOS
// user notification -- wiring that up is that later integration's job, not this executor's.
let activeNotifier: PushNotifier = () => {};

export function configurePushNotifier(notifier: PushNotifier): void {
  activeNotifier = notifier;
}

// Test-only escape hatch (background-tasks.ts precedent): returns the module to its default no-op
// state so one test file's injected spy can never leak into another's assertions.
export function resetPushNotifierForTest(): void {
  activeNotifier = () => {};
}

interface PushNotificationInput {
  message: string;
  status: "proactive";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseInput(raw: unknown): PushNotificationInput {
  if (!isPlainObject(raw)) throw new Error("input must be an object");
  const message = raw["message"];
  if (typeof message !== "string" || message.length === 0) throw new Error("message must be a non-empty string");
  if (message.length > MAX_MESSAGE_LENGTH) throw new Error(`message must be under 200 characters (got ${message.length})`);
  const status = raw["status"];
  if (status !== "proactive") throw new Error(`status must be "proactive" (got ${JSON.stringify(status)})`);
  return { message, status };
}

async function execute(rawInput: unknown, _ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  let input: PushNotificationInput;
  try {
    input = parseInput(rawInput);
  } catch (e) {
    return { output: `Error: ${(e as Error).message}`, isError: true };
  }

  // Best-effort, fire-and-forget: a throwing injected/host notifier must never fail the tool call
  // itself -- the pinned result below is a fixed acknowledgment shape (WS-06 §3.3), not a live
  // delivery receipt. Real delivery error surfacing is WS-15's job once a real transport exists.
  try {
    activeNotifier(input.message);
  } catch {
    // Deliberately swallowed -- see comment above.
  }

  return {
    output: JSON.stringify({
      message: input.message,
      localSent: true,
      pushSent: false,
      disabledReason: DISABLED_REASON,
      sentAt: new Date().toISOString(),
    }),
  };
}

replaceExecutor("PushNotification", { execute } satisfies ToolExecutor);
