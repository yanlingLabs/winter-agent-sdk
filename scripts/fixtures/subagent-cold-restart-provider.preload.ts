// Test-only injection into real main.ts subprocesses. Production session/provider selection,
// transcript storage, tool dispatch and roster restoration all remain in the path under test.
import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
import * as providers from "../../packages/runtime/src/provider/mock.ts";
import type { Provider } from "../../packages/runtime/src/engine.ts";

const calls = providers.testProviderByName("calls");
const provider: Provider = {
  async generate(request) {
    // The real engine gives descendants a distinct cache key. Do not rely on a restored
    // persona or history to identify a child: losing either must make the assertion fail.
    if (!request.cacheKey?.includes(":")) return calls.generate(request);
    if (request.system?.includes("COLD_RESTART_NESTED_SPAWNER")) return calls.generate(request);
    const history = JSON.stringify(request.messages);
    const users = request.messages.filter((message) => message.role === "user").map(providers.userMessageText);
    const phase = users.at(-1)?.includes("FOLLOWUP_TWO") ? "FOLLOWUP_TWO"
      : users.at(-1)?.includes("FOLLOWUP_ONE") ? "FOLLOWUP_ONE" : "INITIAL";
    const madeInitialEffect = request.messages.some((message) => message.role === "assistant" && Array.isArray(message.content)
      && message.content.some((block) => block.type === "tool_use" && block.id === "initial-effect"));
    const report = {
      phase,
      markerSeen: history.includes("COLD_RESTART_SECRET_MARKER"),
      personaSeen: request.system?.includes("COLD_RESTART_PERSONA") === true,
      priorReplies: request.messages.filter((message) => message.role === "assistant"
        && providers.userMessageText(message).includes("COLD_RESTART_REPLY:")).length,
      cacheKey: request.cacheKey,
      pid: process.pid,
    };
    appendFileSync(process.env.WINTER_COLD_RESTART_REPORTS!, JSON.stringify(report) + "\n");
    if (phase === "INITIAL" && !madeInitialEffect) {
      return { kind: "tool_use", calls: [{ id: "initial-effect", name: "Bash", input: {
        command: "printf '%s\\n' initial-effect >> initial-effects.txt", description: "Record initial effect",
      } }] };
    }
    return { kind: "text", text: "COLD_RESTART_REPLY:" + JSON.stringify(report) };
  },
};

mock.module("../../packages/runtime/src/provider/mock.ts", () => ({
  ...providers,
  testProviderForNamespace: (name: string) => name === "calls" ? provider : providers.testProviderForNamespace(name),
}));
