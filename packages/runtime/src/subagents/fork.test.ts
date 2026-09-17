import { describe, test, expect } from "bun:test";
import type { ContentBlock, ProviderMessage } from "../engine.ts";
import { FORK_PLACEHOLDER_TOOL_RESULT, isForkRequest, resolveForkInitialMessages } from "./fork.ts";
// Review r2 finding 1's own end-to-end proof: drive a fork-seeded history through BOTH real wire
// mappers (not a hand-rolled stand-in for either) and assert neither sees a dangling tool_use.
// Deep relative imports into provider-runtime's own adapter modules, not the package barrel
// (`@yanlinglabs/winter-provider-runtime`'s `index.ts` is FROZEN and never re-exports these --
// `runtime → provider-runtime` is the declared dependency direction (provider-runtime/src/index.ts's
// own header), and existing tests in this package already reach into provider-runtime's adapters
// this same way, e.g. brand-rebrand.test.ts).
import { toWireMessages } from "../../../provider-runtime/src/adapters/anthropic/messages.ts";
import { mapResponsesInput } from "../../../provider-runtime/src/adapters/openai/responses.ts";

describe("resolveForkInitialMessages (WS-10 §3.5)", () => {
  test("no messages on the inheritance -> empty array (a bare/definition-backed child)", () => {
    expect(resolveForkInitialMessages({})).toEqual([]);
  });

  test("fork messages are copied verbatim, in order, when the last message carries no tool_use", () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];
    expect(resolveForkInitialMessages({ messages })).toEqual(messages);
  });

  test("the returned array is a genuine COPY -- mutating it never touches the original inherit.messages", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    const inherit = { messages };
    const result = resolveForkInitialMessages(inherit);
    result.push({ role: "assistant", content: "mutated" });
    expect(inherit.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(result.length).toBe(2);
  });

  // Review r2 finding 1 (whole-branch): at fork time the parent's own live `messages` always ends
  // on the assistant message that batched THIS round's tool_use blocks (the Agent(fork) call
  // itself, plus any sibling calls the model issued in the same turn) -- engine.ts's own round loop
  // pushes that assistant message before executing any of its calls, and files this round's own
  // tool_results only after every one of them (including this spawn) returns. Handed to a provider
  // unmodified, that history ends on a dangling tool_use with no tool_result -- both the Anthropic
  // and the OpenAI Responses wire mappers reject a request shaped that way.
  describe("synthetic tool_result for every unanswered tool_use in the LAST assistant message", () => {
    test("a single trailing tool_use gets one synthetic tool_result, appended as a new tool message", () => {
      const toolUse: ContentBlock = { type: "tool_use", id: "call-1", name: "Agent", input: { subagent_type: "fork" } };
      const messages: ProviderMessage[] = [{ role: "user", content: "go" }, { role: "assistant", content: [toolUse] }];
      const result = resolveForkInitialMessages({ messages });
      expect(result).toHaveLength(3);
      expect(result[2]).toEqual({
        role: "tool",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: FORK_PLACEHOLDER_TOOL_RESULT }],
      });
    });

    test("SIBLING tool_use calls in the same batched round each get their own synthetic tool_result", () => {
      const calls: Array<Extract<ContentBlock, { type: "tool_use" }>> = [
        { type: "tool_use", id: "call-fork", name: "Agent", input: {} },
        { type: "tool_use", id: "call-sibling-1", name: "Bash", input: { command: "echo hi" } },
        { type: "tool_use", id: "call-sibling-2", name: "Read", input: { file_path: "/x" } },
      ];
      const messages: ProviderMessage[] = [{ role: "assistant", content: calls }];
      const result = resolveForkInitialMessages({ messages });
      expect(result).toHaveLength(2);
      const synthetic = result[1]!;
      expect(synthetic.role).toBe("tool");
      const blocks = synthetic.content as ContentBlock[];
      expect(blocks).toHaveLength(3);
      for (const call of calls) {
        const match = blocks.find((b) => b.type === "tool_result" && b.tool_use_id === call.id);
        expect(match).toEqual({ type: "tool_result", tool_use_id: call.id, content: FORK_PLACEHOLDER_TOOL_RESULT });
      }
      // No `is_error` -- the fork genuinely started; this is a placeholder, not a failure report.
      for (const block of blocks) expect((block as { is_error?: boolean }).is_error).toBeUndefined();
    });

    test("a trailing assistant message with only TEXT (no tool_use) is left alone -- nothing to answer", () => {
      const messages: ProviderMessage[] = [{ role: "assistant", content: "just text, no calls" }];
      expect(resolveForkInitialMessages({ messages })).toEqual(messages);
    });

    test("a trailing assistant message whose content array has no tool_use blocks is left alone", () => {
      const messages: ProviderMessage[] = [{ role: "assistant", content: [{ type: "text", text: "hello" }] }];
      expect(resolveForkInitialMessages({ messages })).toEqual(messages);
    });

    test("a last message that is NOT the assistant's (already answered / a plain user turn) is left alone", () => {
      const messages: ProviderMessage[] = [
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Bash", input: {} }] },
        { role: "tool", content: [{ type: "tool_result", tool_use_id: "c1", content: "done" }] },
      ];
      expect(resolveForkInitialMessages({ messages })).toEqual(messages);
    });

    test("does not mutate the original inherit.messages array or its assistant message", () => {
      const toolUse: ContentBlock = { type: "tool_use", id: "call-1", name: "Agent", input: {} };
      const assistantMsg: ProviderMessage = { role: "assistant", content: [toolUse] };
      const messages = [assistantMsg];
      const result = resolveForkInitialMessages({ messages });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toBe(assistantMsg);
      expect(result).toHaveLength(2);
    });
  });
});

describe("isForkRequest", () => {
  test("true only when fork is literally true", () => {
    expect(isForkRequest({ fork: true })).toBe(true);
    expect(isForkRequest({})).toBe(false);
  });
});

// Review r2 finding 1, end-to-end proof: a fork-seeded history run through the SAME wire mappers
// the real provider adapters use, for BOTH families this fix must hold on -- Anthropic (nested
// blocks, merged by role) and the OpenAI Responses API (a flat item list, no roles at all). Both
// reject or corrupt a request whose last tool_use has no answering result; this proves neither does
// once `resolveForkInitialMessages` has run.
describe("fork history through the real wire adapters (no unanswered tool_use reaches either)", () => {
  // A realistic parent turn: the model batched the fork spawn ALONGSIDE two sibling calls in one
  // round (exactly the shape engine.ts's own round loop produces -- see fork.ts's own header).
  function buildForkedParentHistory(): ProviderMessage[] {
    const calls: ContentBlock[] = [
      { type: "tool_use", id: "toolu_fork", name: "Agent", input: { subagent_type: "fork", description: "d", prompt: "carry on" } },
      { type: "tool_use", id: "toolu_sibling", name: "Bash", input: { command: "echo hi" } },
    ];
    return [
      { role: "user", content: "please fork and also run a command" },
      { role: "assistant", content: calls },
    ];
  }

  // The fork directive itself: child-engine.ts's own `startGeneration` writes this as a fresh
  // `{type:"user", text: liveText}` frame AFTER `initialMessages` has seeded the history (see
  // child-engine.ts:~1050/1225) -- never folded into the synthetic tool_result message itself.
  function withDirective(initial: ProviderMessage[]): ProviderMessage[] {
    return [...initial, { role: "user", content: "Your directive: carry on" }];
  }

  test("Anthropic: every tool_use in the wire request has an answering tool_result, and roles still alternate", () => {
    const initial = resolveForkInitialMessages({ messages: buildForkedParentHistory() });
    const full = withDirective(initial);
    const wire = toWireMessages(full);

    // No two consecutive entries share a role -- the merge did its job, so this is a request a real
    // Anthropic endpoint accepts shape-wise (it rejects consecutive same-role turns outright).
    for (let i = 1; i < wire.length; i++) expect(wire[i]!.role).not.toBe(wire[i - 1]!.role);

    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const entry of wire) {
      for (const block of entry.content) {
        if (block["type"] === "tool_use") toolUseIds.add(block["id"] as string);
        if (block["type"] === "tool_result") toolResultIds.add(block["tool_use_id"] as string);
      }
    }
    expect([...toolUseIds].sort()).toEqual(["toolu_fork", "toolu_sibling"]);
    // Every tool_use answered -- the property this whole fix exists for.
    expect(toolResultIds.has("toolu_fork")).toBe(true);
    expect(toolResultIds.has("toolu_sibling")).toBe(true);

    // The tool_result content is the constant placeholder, riding the entry immediately after the
    // assistant's tool_use turn (merged with the directive's own user text into ONE wire entry --
    // Anthropic's dialect has no separate "tool" role, so `role:"tool"` collapses into `user`).
    const assistantIdx = wire.findIndex((e) => e.role === "assistant");
    const answerEntry = wire[assistantIdx + 1]!;
    expect(answerEntry.role).toBe("user");
    const forkResult = answerEntry.content.find((b) => b["type"] === "tool_result" && b["tool_use_id"] === "toolu_fork");
    expect(forkResult).toMatchObject({ content: FORK_PLACEHOLDER_TOOL_RESULT });
  });

  test("OpenAI Responses: every function_call has a matching function_call_output later in the item list", () => {
    const initial = resolveForkInitialMessages({ messages: buildForkedParentHistory() });
    const full = withDirective(initial);
    const items = mapResponsesInput(full) as Array<Record<string, unknown>>;

    const callIds = items.filter((i) => i["type"] === "function_call").map((i) => i["call_id"] as string);
    const outputIds = new Set(items.filter((i) => i["type"] === "function_call_output").map((i) => i["call_id"] as string));
    expect(callIds.sort()).toEqual(["toolu_fork", "toolu_sibling"]);
    for (const id of callIds) expect(outputIds.has(id)).toBe(true);

    // Ordering: each function_call_output appears strictly AFTER its own function_call -- the
    // property the Responses API actually enforces (an output preceding its call 400s).
    for (const id of callIds) {
      const callIdx = items.findIndex((i) => i["type"] === "function_call" && i["call_id"] === id);
      const outputIdx = items.findIndex((i) => i["type"] === "function_call_output" && i["call_id"] === id);
      expect(outputIdx).toBeGreaterThan(callIdx);
    }

    const forkOutput = items.find((i) => i["type"] === "function_call_output" && i["call_id"] === "toolu_fork");
    expect(forkOutput).toMatchObject({ output: FORK_PLACEHOLDER_TOOL_RESULT });
  });

  test("a fork with NO sibling calls: the single tool_use is answered on both adapters", () => {
    const solo: ProviderMessage[] = [{ role: "assistant", content: [{ type: "tool_use", id: "toolu_solo", name: "Agent", input: {} }] }];
    const full = withDirective(resolveForkInitialMessages({ messages: solo }));

    const wire = toWireMessages(full);
    const wireResultIds = wire.flatMap((e) => e.content).filter((b) => b["type"] === "tool_result").map((b) => b["tool_use_id"]);
    expect(wireResultIds).toContain("toolu_solo");

    const items = mapResponsesInput(full) as Array<Record<string, unknown>>;
    const responsesOutputIds = items.filter((i) => i["type"] === "function_call_output").map((i) => i["call_id"]);
    expect(responsesOutputIds).toContain("toolu_solo");
  });
});
