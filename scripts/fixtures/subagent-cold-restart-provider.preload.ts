// Test-only injection into real main.ts subprocesses. Production session/provider selection,
// transcript storage, tool dispatch and roster restoration all remain in the path under test.
import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
import * as providers from "../../packages/runtime/src/provider/mock.ts";
import type { Provider, ProviderMessage, ProviderRequest } from "../../packages/runtime/src/engine.ts";
import { toWireMessages } from "../../packages/provider-runtime/src/adapters/anthropic/messages.ts";

const calls = providers.testProviderByName("calls");
function generateCalls(request: ProviderRequest) {
  // The production request assembler can fold the new prompt into a trailing result message.
  // The generic test calls parser only looks at role:user; expose that text to its parser after
  // validating the real, unmodified request, without altering runtime history or serialization.
  return calls.generate({ ...request, messages: request.messages.map((message): ProviderMessage =>
    message.role === "tool" && providers.userMessageText(message).split("\n").some((line) => line.trim().startsWith("CALL "))
      ? { ...message, role: "user" } : message) });
}
const provider: Provider = {
  async generate(request) {
    // Inspect the actual Anthropic wire conversion, independently of resume's repair algorithm.
    // Every tool round must be answered in the immediately following user message, and its
    // results must precede ordinary text. A permissive calls provider would hide the regression.
    const pending = new Set<string>();
    for (const message of toWireMessages(request.messages)) {
      if (message.role !== "user" && pending.size > 0)
        throw new Error(`provider400: missing results before ${message.role}: ${[...pending].join(",")}`);
      for (const block of message.content) {
        if (block.type === "tool_use") pending.add(String(block.id));
        else if (block.type === "tool_result") {
          if (!pending.delete(String(block.tool_use_id))) throw new Error(`provider400: unexpected result ${block.tool_use_id}`);
        } else if (message.role === "user" && pending.size > 0) {
          throw new Error(`provider400: input before tool results: ${[...pending].join(",")}`);
        }
      }
      if (message.role === "user" && pending.size > 0) throw new Error(`provider400: incomplete result round: ${[...pending].join(",")}`);
    }
    if (pending.size > 0) throw new Error(`provider400: missing results: ${[...pending].join(",")}`);
    // The real engine gives descendants a distinct cache key. Do not rely on a restored
    // persona or history to identify a child: losing either must make the assertion fail.
    if (!request.cacheKey?.includes(":")) return generateCalls(request);
    if (request.system?.includes("COLD_RESTART_NESTED_SPAWNER")) return generateCalls(request);
    const history = JSON.stringify(request.messages);
    const users = request.messages.filter((message) => message.role === "user" || message.role === "tool").map(providers.userMessageText);
    const phase = users.at(-1)?.includes("FOLLOWUP_CRASH") ? "FOLLOWUP_CRASH"
      : users.at(-1)?.includes("FOLLOWUP_TWO") ? "FOLLOWUP_TWO"
      : users.at(-1)?.includes("FOLLOWUP_ONE") ? "FOLLOWUP_ONE" : "INITIAL";
    const madeInitialEffect = request.messages.some((message) => message.role === "assistant" && Array.isArray(message.content)
      && message.content.some((block) => block.type === "tool_use" && block.id === "initial-effect"));
    const report = {
      phase,
      markerSeen: history.includes("COLD_RESTART_SECRET_MARKER"),
      personaSeen: request.system?.includes("COLD_RESTART_PERSONA") === true,
      currentPersonaSeen: request.system?.includes("COLD_RESTART_CURRENT_PERSONA") === true,
      interruptedIds: request.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .filter((block) => block.type === "tool_result" && block.interrupted === true)
        .map((block) => block.type === "tool_result" ? block.tool_use_id : ""),
      historyValid: true,
      priorReplies: request.messages.filter((message) => message.role === "assistant"
        && providers.userMessageText(message).includes("COLD_RESTART_REPLY:")).length,
      cacheKey: request.cacheKey,
      pid: process.pid,
    };
    appendFileSync(process.env.WINTER_COLD_RESTART_REPORTS!, JSON.stringify(report) + "\n");
    if (users.at(-1)?.includes("CRASH_START")) {
      return { kind: "tool_use", calls: [{ id: "crash-call", name: "Bash", input: {
        command: "printf '%s\\n' crash-effect >> crash-effects.txt; printf '%s\\n' started > crash-started.txt; sleep 4",
        description: "Pause after the durable side effect so the parent can be killed mid-tool",
      } }] };
    }
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
