// Task 7 (Lane D, WS-10 §10.1): the SendMessage executor — since R-8-1, a THIN BINDING of the SDK's
// own handler rather than a second implementation of it.
//
// WHAT MOVED, AND WHY. Input validation, summary derivation/truncation, the caller-address
// construction, the result rendering and the failure classification all used to live here, and a
// near-identical copy of every one of them lived in `@yanlinglabs/winter-runtime-sdk`. Where the two
// differed, they differed on the MODEL-VISIBLE contract — one refused an overlong `summary` and the
// other truncated it; one marked a `refused` outcome as an error result and the other did not; one
// tolerated an unknown argument and the other refused it. WS-10 §10.1 requires "this exact
// model-facing schema" on both branches, so those were not three tidy-ups: they were the schema
// drifting between branches, in the one place a test in either repo alone could not see.
//
// The user's ruling R-8-1 settles ownership — Winter owns its default tools; the router only binds
// them — and ruling P-4 settled each divergence. Both now live in
// `@yanlinglabs/winter-agent-sdk/tools`, and this file does three things: name the caller, resolve
// the process-level messaging runtime, and translate `{ text, isError? }` into this registry's
// `{ output, isError }`.
//
// TWO MODEL-VISIBLE CHANGES ARRIVE WITH THAT BINDING, both deliberate (ruling P-4):
//   * `refused`/`ambiguous`/`not_found`/`unavailable` now carry `isError: true`. This runtime used to
//     return every outcome as an ordinary success and let the model infer failure from the JSON —
//     which is exactly the reading a model skips when the result looks like it worked.
//   * the result text is the OUTCOME, rendered whole (`{"status":…,"messageId":…}`), rather than the
//     internal `{"outcome":{…}}` envelope. WS-10 §10.1's "the result reports success/message and MAY
//     include a message ID … or a CLASSIFIED FAILURE" describes the outcome itself; the envelope was
//     this runtime's own `SendMessageResult` leaking into the model's view, and it was never what the
//     other branch showed. A combined call's supplementary `notify` fact rides beside the status.
import "../descriptors/send-message.ts";
import "../descriptors/winter-send-message.ts"; // rider 15: the canonical alias-target descriptor this file also installs an executor for.
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { WINTER_BRAND, mcpToolName } from "@yanlinglabs/winter-agent-sdk";
import { acceptNativeSendMessageArgs, createMessagingToolHandlers, messagingToolPortFromRuntimeDeps, SEND_MESSAGE_DEFINITION } from "@yanlinglabs/winter-agent-sdk/tools";
import { getMessagingRuntime } from "../../messaging/router.ts";
// Side-effect-free (types only), so importing this executor does not register anyone else's tool --
// see impl/_caller.ts's own header (SB review r1).
import { callerContextFrom } from "./_caller.ts";

/** Read off the one definition, so the registered name and the descriptor's can never disagree. */
export const SEND_MESSAGE_TOOL_NAME = SEND_MESSAGE_DEFINITION.builtinName ?? SEND_MESSAGE_DEFINITION.toolName;

export const sendMessageExecutor: ToolExecutor = {
  async execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    // THE SCHEMA ANSWER COMES FIRST, before any infrastructure is resolved -- "an invalid call never
    // enters the messaging system", and a model that sent a malformed call deserves the correctable
    // schema error rather than a message about this host's wiring. This is the SAME acceptor the
    // handler runs (it is pure, and re-running it costs nothing); the ORDER is what lives here,
    // because the SDK handler cannot know that this host resolves its runtime lazily.
    const accepted = acceptNativeSendMessageArgs(input);
    if (!accepted.ok) return { output: accepted.reason, isError: true };

    // Resolved PER CALL, not bound at module load: the process-level runtime is host composition and
    // a session may be wired after this module is evaluated.
    const runtime = getMessagingRuntime();
    if (runtime === undefined) {
      return { output: "Error: SendMessage has no messaging runtime configured for this session", isError: true };
    }
    const handlers = createMessagingToolHandlers(messagingToolPortFromRuntimeDeps(runtime), callerContextFrom(ctx));
    const { text, isError } = await handlers.sendMessage(input);
    return { output: text, ...(isError === true ? { isError: true } : {}) };
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
// `deferred: true` at the source) is what keeps the model from normally seeing both. Since R-8-1
// both descriptors also share ONE schema object, so the pair cannot drift in either direction.
export const WINTER_CANONICAL_SEND_MESSAGE_TOOL_NAME = mcpToolName(WINTER_BRAND, SEND_MESSAGE_DEFINITION.toolName);
replaceExecutor(WINTER_CANONICAL_SEND_MESSAGE_TOOL_NAME, sendMessageExecutor);
