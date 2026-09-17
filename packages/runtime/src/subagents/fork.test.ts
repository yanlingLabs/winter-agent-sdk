import { describe, test, expect } from "bun:test";
import type { ContentBlock, ProviderMessage } from "../engine.ts";
import { FORK_PLACEHOLDER_TOOL_RESULT, ForkRequestLayoutUnavailableError, buildForkDirectiveText, buildForkInitialMessages, isForkRequest } from "./fork.ts";
// Review r2 finding 1's own end-to-end proof (0.0.15), carried forward: drive a fork-seeded history
// through BOTH real wire mappers (not a hand-rolled stand-in for either) and assert neither sees a
// dangling tool_use. Deep relative imports into provider-runtime's own adapter modules, not the
// package barrel (see the 0.0.15 header this replaces for why).
import { toWireMessages } from "../../../provider-runtime/src/adapters/anthropic/messages.ts";
import { mapResponsesInput } from "../../../provider-runtime/src/adapters/openai/responses.ts";

describe("buildForkInitialMessages (WS-10 §3.5, SDK 0.0.16 P16-7, ground truth per d2-report.md)", () => {
  test("no messages on the inheritance -> empty array (a bare/definition-backed child)", () => {
    expect(buildForkInitialMessages({}, "toolu_x")).toEqual([]);
  });

  test("messages present but nothing matches forkToolUseId -> the filtered history, unchanged, no clone/placeholder appended", () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];
    expect(buildForkInitialMessages({ messages }, "toolu_never_called")).toEqual(messages);
  });

  test("the returned array is a genuine COPY -- mutating it never touches the original inherit.messages", () => {
    const toolUse: ContentBlock = { type: "tool_use", id: "call-1", name: "Agent", input: { subagent_type: "fork" } };
    const messages: ProviderMessage[] = [{ role: "assistant", content: [toolUse] }];
    const inherit = { messages };
    const result = buildForkInitialMessages(inherit, "call-1");
    result.push({ role: "assistant", content: "mutated" });
    expect(inherit.messages).toEqual([{ role: "assistant", content: [toolUse] }]);
    expect(result.length).toBe(3); // [] (the whole msg was unanswered -> dropped) + clone + tool_result
  });

  describe("history shape: filter -> clone (own tool_use only) -> placeholder tool_result", () => {
    test("a solo tool_use: the whole assistant message is dropped from history, then reappears as a 1-block clone + a tool_result answering it", () => {
      const toolUse: ContentBlock = { type: "tool_use", id: "call-1", name: "Agent", input: { subagent_type: "fork" } };
      const messages: ProviderMessage[] = [{ role: "user", content: "go" }, { role: "assistant", content: [toolUse] }];
      const result = buildForkInitialMessages({ messages }, "call-1");
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual(messages[0]); // history minus the unanswered assistant message
      expect(result[1]).toEqual({ role: "assistant", content: [toolUse] }); // the clone (identical here: only one block existed)
      expect(result[2]).toEqual({ role: "tool", content: [{ type: "tool_result", tool_use_id: "call-1", content: FORK_PLACEHOLDER_TOOL_RESULT }] });
    });

    // d2-report.md's own CORRECTION over r3a §2's original ("ALL BLOCKS KEPT") claim, pinned against
    // the real pinned binary and against fork-request-bytes-differential.test.ts's own
    // `cloneBlocks.length === 1` assertion: each fork's own clone keeps ONLY its own tool_use block.
    test("SIBLING tool_use calls batched in the SAME message: this fork's own clone drops the sibling entirely", () => {
      const forkCall: ContentBlock = { type: "tool_use", id: "call-fork", name: "Agent", input: { subagent_type: "fork", prompt: "mine" } };
      const siblingCall: ContentBlock = { type: "tool_use", id: "call-sibling", name: "Agent", input: { subagent_type: "fork", prompt: "not mine" } };
      const messages: ProviderMessage[] = [{ role: "user", content: "spawn two forks" }, { role: "assistant", content: [forkCall, siblingCall] }];

      const result = buildForkInitialMessages({ messages }, "call-fork");
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual(messages[0]);
      const clone = result[1]!;
      expect(clone.role).toBe("assistant");
      const cloneBlocks = clone.content as ContentBlock[];
      expect(cloneBlocks).toHaveLength(1); // NOT 2 -- the sibling's own tool_use is gone, not merely unanswered
      expect(cloneBlocks[0]).toEqual(forkCall);
      expect(result[2]).toEqual({ role: "tool", content: [{ type: "tool_result", tool_use_id: "call-fork", content: FORK_PLACEHOLDER_TOOL_RESULT }] });

      // The OTHER sibling's own build (a second, independent spawn off the SAME parent message)
      // clones the OTHER block -- proving the two sibling clones genuinely diverge from each other,
      // not just from the original message.
      const siblingResult = buildForkInitialMessages({ messages }, "call-sibling");
      const siblingClone = siblingResult[1]!;
      expect((siblingClone.content as ContentBlock[])[0]).toEqual(siblingCall);
      expect(siblingResult[1]).not.toEqual(clone);
    });

    test("a non-tool_use block (text) accompanying this fork's own tool_use in the same message is ALSO dropped from the clone -- ONLY the tool_use survives", () => {
      const text: ContentBlock = { type: "text", text: "I'll delegate this." };
      const forkCall: ContentBlock = { type: "tool_use", id: "call-1", name: "Agent", input: {} };
      const messages: ProviderMessage[] = [{ role: "assistant", content: [text, forkCall] }];
      const result = buildForkInitialMessages({ messages }, "call-1");
      const clone = result[0]!; // the whole original message was unanswered -> dropped; nothing precedes the clone
      expect((clone.content as ContentBlock[])).toEqual([forkCall]);
    });

    test("drops nativeState from the clone (adapter-owned continuation state a partial clone cannot honestly carry) but keeps origin", () => {
      const forkCall: ContentBlock = { type: "tool_use", id: "call-fork", name: "Agent", input: {} };
      const siblingCall: ContentBlock = { type: "tool_use", id: "call-sibling", name: "Bash", input: {} };
      const original: ProviderMessage = {
        role: "assistant",
        content: [forkCall, siblingCall],
        origin: { providerId: "openai", modelKey: "openai/gpt-x", family: "openai" },
        nativeState: { family: "openai", continuationDomain: "openai:responses", items: [{ type: "function_call", call_id: "call-fork" }, { type: "function_call", call_id: "call-sibling" }] },
      };
      const result = buildForkInitialMessages({ messages: [original] }, "call-fork");
      const clone = result[0]!;
      expect(clone.origin).toEqual(original.origin);
      expect(clone.nativeState).toBeUndefined();
    });

    test("uuid is never copied onto the clone -- it is a genuinely new message, not a replay", () => {
      const forkCall: ContentBlock = { type: "tool_use", id: "call-1", name: "Agent", input: {} };
      const original: ProviderMessage = { role: "assistant", content: [forkCall], uuid: "original-uuid" };
      const result = buildForkInitialMessages({ messages: [original] }, "call-1");
      expect(result[0]!.uuid).toBeUndefined();
    });

    test("an EARLIER assistant message with an already-answered tool_use is kept untouched -- only the unanswered one is dropped", () => {
      const earlierCall: ContentBlock = { type: "tool_use", id: "call-earlier", name: "Bash", input: {} };
      const forkCall: ContentBlock = { type: "tool_use", id: "call-fork", name: "Agent", input: {} };
      const messages: ProviderMessage[] = [
        { role: "user", content: "first, run a command" },
        { role: "assistant", content: [earlierCall] },
        { role: "tool", content: [{ type: "tool_result", tool_use_id: "call-earlier", content: "ok" }] },
        { role: "user", content: "now fork" },
        { role: "assistant", content: [forkCall] },
      ];
      const result = buildForkInitialMessages({ messages }, "call-fork");
      // history minus the unanswered assistant message (index 4) = the first 4 entries, untouched
      expect(result.slice(0, 4)).toEqual(messages.slice(0, 4));
      expect(result[4]).toEqual({ role: "assistant", content: [forkCall] });
      expect(result[5]).toEqual({ role: "tool", content: [{ type: "tool_result", tool_use_id: "call-fork", content: FORK_PLACEHOLDER_TOOL_RESULT }] });
    });
  });
});

describe("isForkRequest", () => {
  test("true only when fork is literally true", () => {
    expect(isForkRequest({ fork: true })).toBe(true);
    expect(isForkRequest({})).toBe(false);
  });
});

describe("buildForkDirectiveText (Winter-authored boilerplate + claude's own 'Your directive: ' prefix)", () => {
  test("ends with 'Your directive: <prompt>', nothing trailing (fork-request-bytes-differential.test.ts's own pinned suffix)", () => {
    const text = buildForkDirectiveText({ prompt: "investigate the first half" });
    expect(text.endsWith("Your directive: investigate the first half")).toBe(true);
  });

  test("two calls with the SAME prompt/no worktree produce byte-identical text (the boilerplate is a constant)", () => {
    const a = buildForkDirectiveText({ prompt: "same task" });
    const b = buildForkDirectiveText({ prompt: "same task" });
    expect(a).toBe(b);
  });

  test("the boilerplate PREFIX (everything before 'Your directive:') is identical across two DIFFERENT prompts -- the sibling-cache-sharing property", () => {
    const a = buildForkDirectiveText({ prompt: "investigate the first half" });
    const b = buildForkDirectiveText({ prompt: "investigate the second half" });
    const aPrefix = a.slice(0, a.indexOf("Your directive:"));
    const bPrefix = b.slice(0, b.indexOf("Your directive:"));
    expect(aPrefix).toBe(bPrefix);
    expect(aPrefix.length).toBeGreaterThan(0);
  });

  // VERIFIED against the pinned 0.3.250 binary's own decompiled source (`_Fn`'s call site: claude
  // pushes the worktree note as its OWN transcript entry AFTER `yFn`'s own [clone, tool_result+
  // directive] pair -- never before the directive). `buildForkDirectiveText` places it after
  // "Your directive: <prompt>" for the same reason -- see `worktreeNote`'s own header for the
  // disclosed gap (a genuinely separate wire message vs. this folded paragraph).
  test("a worktree fork's text names both the parent's root and the worktree root, AFTER the directive (verified ordering, not before it)", () => {
    const text = buildForkDirectiveText({ prompt: "task", worktree: { parentRoot: "/tmp/winter-parent-cwd", worktreeRoot: "/tmp/winter-worktree-abc" } });
    expect(text).toContain("/tmp/winter-parent-cwd");
    expect(text).toContain("/tmp/winter-worktree-abc");
    const directiveIdx = text.indexOf("Your directive: task");
    expect(directiveIdx).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("/tmp/winter-worktree-abc")).toBeGreaterThan(directiveIdx); // the note trails the directive
  });

  test("the shared boilerplate PREFIX (before 'Your directive:') is IDENTICAL regardless of worktree -- the note trails the directive, so it never touches the cache-shareable prefix", () => {
    const bare = buildForkDirectiveText({ prompt: "x" });
    const worktreeA = buildForkDirectiveText({ prompt: "x", worktree: { parentRoot: "/tmp/p", worktreeRoot: "/tmp/wt-a" } });
    const worktreeB = buildForkDirectiveText({ prompt: "y", worktree: { parentRoot: "/tmp/p", worktreeRoot: "/tmp/wt-b" } });
    const prefixOf = (t: string) => t.slice(0, t.indexOf("Your directive:"));
    expect(prefixOf(worktreeA)).toBe(prefixOf(bare));
    expect(prefixOf(worktreeB)).toBe(prefixOf(bare));
  });

  test("Winter-authored: never contains an Anthropic/claude product name (R-S3)", () => {
    const text = buildForkDirectiveText({ prompt: "x" });
    expect(text.toLowerCase()).not.toContain("claude");
    expect(text.toLowerCase()).not.toContain("anthropic");
  });
});

describe("ForkRequestLayoutUnavailableError", () => {
  test("is a real Error with a legible, typed name", () => {
    const err = new ForkRequestLayoutUnavailableError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ForkRequestLayoutUnavailableError");
    expect(err.message.length).toBeGreaterThan(0);
  });
});

// Review r2 finding 1, end-to-end proof (0.0.15, carried forward under the new d2-corrected shape): a
// fork-seeded history run through the SAME wire mappers the real provider adapters use, for BOTH
// families this fix must hold on. Both reject or corrupt a request whose last tool_use has no
// answering result; this proves neither does once `buildForkInitialMessages` has run.
describe("fork history through the real wire adapters (no unanswered tool_use reaches either)", () => {
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

  // child-engine.ts's own `startGeneration` writes the directive as a fresh `{type:"user", text}`
  // frame AFTER `initialMessages` has seeded the history -- `context/request-layout.ts`'s own
  // message-merge logic (consecutive user-role entries merge, tool_result hoisted first) folds it
  // into the SAME wire message as the placeholder tool_result, which is what this helper simulates.
  function withDirective(initial: ProviderMessage[], directive: string): ProviderMessage[] {
    return [...initial, { role: "user", content: directive }];
  }

  test("Anthropic: every tool_use in the wire request has an answering tool_result, and roles still alternate", () => {
    const initial = buildForkInitialMessages({ messages: buildForkedParentHistory() }, "toolu_fork");
    const full = withDirective(initial, buildForkDirectiveText({ prompt: "carry on" }));
    const wire = toWireMessages(full);

    for (let i = 1; i < wire.length; i++) expect(wire[i]!.role).not.toBe(wire[i - 1]!.role);

    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const entry of wire) {
      for (const block of entry.content) {
        if (block["type"] === "tool_use") toolUseIds.add(block["id"] as string);
        if (block["type"] === "tool_result") toolResultIds.add(block["tool_use_id"] as string);
      }
    }
    // The SIBLING's own tool_use is gone entirely from this fork's own history (d2: dropped, not
    // merely unanswered) -- only THIS fork's own call reaches the wire at all.
    expect([...toolUseIds]).toEqual(["toolu_fork"]);
    expect(toolResultIds.has("toolu_fork")).toBe(true);
    expect(toolResultIds.has("toolu_sibling")).toBe(false);

    const assistantIdx = wire.findIndex((e) => e.role === "assistant");
    const answerEntry = wire[assistantIdx + 1]!;
    expect(answerEntry.role).toBe("user");
    const forkResult = answerEntry.content.find((b) => b["type"] === "tool_result" && b["tool_use_id"] === "toolu_fork");
    expect(forkResult).toMatchObject({ content: FORK_PLACEHOLDER_TOOL_RESULT });
    // The directive text rides the SAME entry as the placeholder tool_result (the merge this file's
    // own header describes), never a separate assistant/user pair.
    const directiveBlock = answerEntry.content.find((b) => b["type"] === "text");
    expect(typeof directiveBlock?.["text"]).toBe("string");
    expect((directiveBlock!["text"] as string).endsWith("Your directive: carry on")).toBe(true);
  });

  test("OpenAI Responses: every function_call has a matching function_call_output later in the item list, and the dropped sibling never appears", () => {
    const initial = buildForkInitialMessages({ messages: buildForkedParentHistory() }, "toolu_fork");
    const full = withDirective(initial, buildForkDirectiveText({ prompt: "carry on" }));
    const items = mapResponsesInput(full) as Array<Record<string, unknown>>;

    const callIds = items.filter((i) => i["type"] === "function_call").map((i) => i["call_id"] as string);
    const outputIds = new Set(items.filter((i) => i["type"] === "function_call_output").map((i) => i["call_id"] as string));
    expect(callIds).toEqual(["toolu_fork"]);
    expect(outputIds.has("toolu_fork")).toBe(true);
    expect(outputIds.has("toolu_sibling")).toBe(false);

    const callIdx = items.findIndex((i) => i["type"] === "function_call" && i["call_id"] === "toolu_fork");
    const outputIdx = items.findIndex((i) => i["type"] === "function_call_output" && i["call_id"] === "toolu_fork");
    expect(outputIdx).toBeGreaterThan(callIdx);

    const forkOutput = items.find((i) => i["type"] === "function_call_output" && i["call_id"] === "toolu_fork");
    expect(forkOutput).toMatchObject({ output: FORK_PLACEHOLDER_TOOL_RESULT });
  });

  test("a fork with NO sibling calls: the single tool_use is answered on both adapters", () => {
    const solo: ProviderMessage[] = [{ role: "assistant", content: [{ type: "tool_use", id: "toolu_solo", name: "Agent", input: {} }] }];
    const full = withDirective(buildForkInitialMessages({ messages: solo }, "toolu_solo"), buildForkDirectiveText({ prompt: "x" }));

    const wire = toWireMessages(full);
    const wireResultIds = wire.flatMap((e) => e.content).filter((b) => b["type"] === "tool_result").map((b) => b["tool_use_id"]);
    expect(wireResultIds).toContain("toolu_solo");

    const items = mapResponsesInput(full) as Array<Record<string, unknown>>;
    const responsesOutputIds = items.filter((i) => i["type"] === "function_call_output").map((i) => i["call_id"]);
    expect(responsesOutputIds).toContain("toolu_solo");
  });
});
