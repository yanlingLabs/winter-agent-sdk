// The switch loss matrix, REWRITTEN for WS-23 (reasoning-state, user decision 9): a switch loses only what
// the target cannot represent -- images/documents for a model that reads none, another vendor's server
// tools, the older part of a conversation the target cannot hold, and an interrupted turn. The source's
// reasoning is NOT lost: it stays in the provider-state sidecar for the source and replays on a switch
// back, so a plain cross-family switch is silent. (The pre-WS-23 reasoning triggers this file used to
// pin -- "a new reasoning context", "only a summary crosses", the policy and completeness triggers -- are
// retired with the summary hand-off they described, which never ran.)
import { describe, expect, test } from "bun:test";
import type { ContinuityEndpoint } from "./domains.ts";
import { classifySwitch } from "./warnings.ts";

const endpoint = (init: Partial<ContinuityEndpoint> & { providerId: string; modelKey: string }): ContinuityEndpoint => ({
  family: init.family ?? "openai",
  readableState: init.readableState ?? "summary",
  ...(init.continuationDomain !== undefined ? { continuationDomain: init.continuationDomain } : {}),
  ...(init.continuation !== undefined ? { continuation: init.continuation } : {}),
  providerId: init.providerId,
  modelKey: init.modelKey,
});

const CLAUDE = endpoint({ providerId: "anthropic", modelKey: "anthropic/claude-a", family: "anthropic", continuationDomain: "anthropic/claude-a" });
const OPENAI = endpoint({ providerId: "openai", modelKey: "openai/o-reason", continuationDomain: "openai/o-reason" });
const OPENAI_SIBLING = endpoint({ providerId: "openai", modelKey: "openai/o-sibling", continuationDomain: "openai/o-reason" });
const DEEPSEEK = endpoint({ providerId: "deepseek", modelKey: "deepseek/r-reason", readableState: "full-exposed", continuationDomain: "deepseek/r-reason" });
const CHAT = endpoint({ providerId: "openai", modelKey: "openai/chat", readableState: "none", continuation: "none" });

describe("reasoning parked in the sidecar is not a loss (WS-23 decision 9)", () => {
  test.each([
    ["Claude -> OpenAI", CLAUDE, OPENAI],
    ["OpenAI -> Claude", OPENAI, CLAUDE],
    ["DeepSeek -> OpenAI", DEEPSEEK, OPENAI],
  ])("%s: silent, `lossless-portable`, and the portable list says the source keeps its reasoning", (_name, from, to) => {
    const verdict = classifySwitch(from, to, { completedToolResults: 2, summaryAvailable: false, exposedComplete: false, truncated: true });
    expect(verdict.lossClass).toBe("lossless-portable");
    expect(verdict.warnings).toEqual([]);
    expect(verdict.portable[0]).toBe("the whole visible conversation, as it is");
    expect(verdict.portable).toContain("2 completed tool results");
    expect(verdict.portable.some((p) => p.includes(`${from.modelKey}'s reasoning, kept for ${from.modelKey} and replayed if you switch back`))).toBe(true);
  });

  test("a certified shared domain is `lossless-native`: the reasoning even replays on the target", () => {
    const verdict = classifySwitch(OPENAI, OPENAI_SIBLING);
    expect(verdict.lossClass).toBe("lossless-native");
    expect(verdict.portable).toContain("openai/o-reason's own reasoning state, replayed exactly");
  });

  test("the same profile is never a switch", () => {
    expect(classifySwitch(CLAUDE, CLAUDE)).toMatchObject({ lossClass: "lossless-native", warnings: [] });
  });

  test("a source with no reasoning transport names no reasoning at all", () => {
    const verdict = classifySwitch(CHAT, CLAUDE);
    expect(verdict.warnings).toEqual([]);
    expect(verdict.portable).toEqual(["the whole visible conversation, as it is"]);
  });
});

describe("the four real losses", () => {
  test("images or documents for a model that reads none", () => {
    const verdict = classifySwitch(CLAUDE, OPENAI, { unreadableMedia: 3 });
    expect(verdict.lossClass).toBe("warned-lossy");
    expect(verdict.warnings).toEqual(["openai/o-reason cannot read images or documents: the 3 in this conversation will reach it as a note that they were there. Everything else carries over as it is."]);
  });

  test("another vendor's server-tool steps reach the target as text", () => {
    const verdict = classifySwitch(CLAUDE, OPENAI, { serverToolBlocks: 1 });
    expect(verdict.warnings).toEqual(["1 step of anthropic's own server-side tools (such as web search) will reach openai/o-reason as plain text rather than as tool results."]);
  });

  test("a compaction the fit check will run -- named with the estimate and the window, and the portable list says what survives", () => {
    const verdict = classifySwitch(CLAUDE, OPENAI, { compaction: { estimatedTokens: 612_000, window: 272_000 } });
    expect(verdict.lossClass).toBe("warned-lossy");
    expect(verdict.warnings[0]).toBe("This conversation (about 612k tokens) is larger than openai/o-reason can hold (a 272k-token window), so anthropic/claude-a will summarize its older part before the switch. The most recent exchanges carry over as they are.");
    expect(verdict.portable[0]).toBe("the recent conversation as it is, and a summary of the older part");
  });

  test("a mid-turn abort warns EVEN INSIDE a shared domain -- the loss is the unfinished turn", () => {
    const verdict = classifySwitch(OPENAI, OPENAI_SIBLING, { midTurnAbort: true });
    expect(verdict.lossClass).toBe("warned-lossy");
    expect(verdict.warnings[0]).toContain("cancelled before it finished");
  });
});

describe("§8.6's rules about the text", () => {
  const warned = [
    classifySwitch(CLAUDE, OPENAI, { unreadableMedia: 1, serverToolBlocks: 2, compaction: { estimatedTokens: 300_000, window: 200_000 }, midTurnAbort: true }),
    classifySwitch(DEEPSEEK, CLAUDE, { compaction: { estimatedTokens: 90_000, window: 64_000 } }),
  ];
  test("no warning claims the visible conversation is lost, and none reads like a summary hand-off", () => {
    for (const verdict of warned) {
      for (const warning of verdict.warnings) {
        expect(warning).not.toMatch(/visible conversation (is|will be) lost/i);
        expect(warning).not.toContain("the objective, the decisions already made");
        expect(warning).not.toContain("reasoning state is bound to");
      }
    }
  });

  test("every warned case names what remains portable, visible conversation first", () => {
    for (const verdict of warned) {
      expect(verdict.portable.length).toBeGreaterThan(0);
      expect(verdict.portable[0]).toMatch(/conversation/);
    }
  });
});
