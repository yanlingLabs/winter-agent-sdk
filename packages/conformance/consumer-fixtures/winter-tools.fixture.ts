// The `/tools` subpath, compiled as a CONSUMER sees it (SDK 0.0.3, ruling R-8-1).
//
// A SECOND FIXTURE FILE, DELIBERATELY, rather than a `/tools` import added to plain-query.fixture.ts.
// That fixture is the DROP-IN SURFACE proof: `scripts/compile-official-fixture.ts` pins it by
// absolute path (`files: [FIXTURE_PATH]`) and compiles it against the real official
// @anthropic-ai/claude-agent-sdk, which has no `/tools` subpath at all. Adding the import there would
// have turned that gate red for the right reason and the wrong purpose. The two winter fixture
// configs include this whole directory by glob, so this file is covered by both of them -- including
// `tsconfig.winter-dist.json`, the one gate that reads the BUILT declarations rather than the source,
// which is the whole point of writing it: a `/tools` export that `rewriteDeclarationSpecifiers`
// mangled, or a subpath the emit does not contain, fails HERE rather than at an installing consumer.
import {
  acceptNativeSendMessageArgs,
  createMessagingToolHandlers,
  messagingToolPortFromRuntimeDeps,
  WINTER_DEFAULT_TOOL_DEFINITIONS,
} from "@sdk-under-test/tools";
import type { MessagingRuntimeDeps, MessagingToolPort, WinterToolDefinition, WinterToolHandler } from "@sdk-under-test/tools";

/** The four default tools, by bare name -- the list a host binds under its own spellings. */
export function defaultToolNames(): string[] {
  const definitions: readonly WinterToolDefinition[] = WINTER_DEFAULT_TOOL_DEFINITIONS;
  return definitions.map((definition) => definition.toolName);
}

/** The port adapter and the handler factory, reached exactly as a host reaches them. */
export function bindMessagingTools(deps: MessagingRuntimeDeps, sessionId: string): { port: MessagingToolPort; sendMessage: WinterToolHandler } {
  const port = messagingToolPortFromRuntimeDeps(deps);
  const handlers = createMessagingToolHandlers(port, { sessionId });
  return { port, sendMessage: handlers.sendMessage };
}

/** And the acceptor, whose result type is the discriminated union a consumer must be able to narrow. */
export function summaryOf(input: unknown): string | undefined {
  const accepted = acceptNativeSendMessageArgs(input);
  return accepted.ok ? accepted.args.summary : undefined;
}
