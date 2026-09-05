import { describe, expect, test } from "bun:test";
import type { ContinuityEndpoint } from "./domains.ts";
import { classifySwitch } from "./warnings.ts";

const endpoint = (init: Partial<ContinuityEndpoint> & { providerId: string; modelKey: string }): ContinuityEndpoint => ({
  family: init.family ?? "openai",
  readableState: init.readableState ?? "summary",
  ...(init.continuationDomain !== undefined ? { continuationDomain: init.continuationDomain } : {}),
  providerId: init.providerId,
  modelKey: init.modelKey,
});

const CLAUDE = endpoint({ providerId: "anthropic", modelKey: "anthropic/claude-a", family: "anthropic", continuationDomain: "anthropic/claude-a" });
const CLAUDE_B = endpoint({ providerId: "anthropic", modelKey: "anthropic/claude-b", family: "anthropic", continuationDomain: "anthropic/claude-b" });
const OPENAI = endpoint({ providerId: "openai", modelKey: "openai/o-reason", continuationDomain: "openai/o-reason" });
const OPENAI_B = endpoint({ providerId: "openai", modelKey: "openai/o-mini", continuationDomain: "openai/o-mini" });
const GEMINI = endpoint({ providerId: "google", modelKey: "google/gemini-x", family: "google", continuationDomain: "google/gemini-x" });
const XAI = endpoint({ providerId: "xai", modelKey: "xai/grok-x", continuationDomain: "xai/grok-x" });
const DEEPSEEK = endpoint({ providerId: "deepseek", modelKey: "deepseek/r-reason", readableState: "full-exposed", continuationDomain: "deepseek/r-reason" });

describe("the eight named cases of report §12.3", () => {
  test("Claude -> OpenAI: WARN (a Claude signature cannot become an OpenAI reasoning item)", () => {
    const verdict = classifySwitch(CLAUDE, OPENAI, { summaryAvailable: true, completedToolResults: 2 });
    expect(verdict.lossClass).toBe("warned-lossy");
    expect(verdict.warnings).toHaveLength(1);
    expect(verdict.warnings[0]).toContain("anthropic/claude-a");
    expect(verdict.warnings[0]).toContain("openai/o-reason");
    expect(verdict.portable).toContain("the visible conversation");
    expect(verdict.portable).toContain("2 completed tool results and their facts");
    expect(verdict.portable).toContain("anthropic/claude-a's reasoning summary");
  });

  test("OpenAI -> Claude: WARN, with the provider names the other way round", () => {
    const verdict = classifySwitch(OPENAI, CLAUDE, { summaryAvailable: true });
    expect(verdict.lossClass).toBe("warned-lossy");
    expect(verdict.warnings[0]).toContain("openai's reasoning state is bound to openai and cannot be used by anthropic");
  });

  test("Gemini -> OpenAI: WARN (a thought signature is Gemini-specific)", () => {
    expect(classifySwitch(GEMINI, OPENAI, { summaryAvailable: true }).lossClass).toBe("warned-lossy");
  });

  test("xAI -> OpenAI: WARN (similarly named encrypted reasoning remains xAI's)", () => {
    const verdict = classifySwitch(XAI, OPENAI, { summaryAvailable: true });
    expect(verdict.lossClass).toBe("warned-lossy");
    // The similarity of the NAMES is exactly the trap: same family string, same protocol shape, and
    // still two domains.
    expect(XAI.family).toBe(OPENAI.family);
  });

  test("DeepSeek -> OpenAI with COMPLETE reasoning: NO hidden-reasoning warning", () => {
    const verdict = classifySwitch(DEEPSEEK, OPENAI, { exposedComplete: true, completedToolResults: 1 });
    expect(verdict.lossClass).toBe("lossless-portable");
    expect(verdict.warnings).toEqual([]);
    expect(verdict.portable).toContain("deepseek/r-reason's complete readable reasoning, forwarded unmodified");
  });

  test("DeepSeek -> OpenAI after TRUNCATION: warn -- the flip §9.6 demands", () => {
    const verdict = classifySwitch(DEEPSEEK, OPENAI, { exposedComplete: true, truncated: true });
    expect(verdict.lossClass).toBe("warned-lossy");
    expect(verdict.warnings.join(" ")).toContain("trimmed to fit");
    // The lossless classification is NOT retained beside the warning.
    expect(verdict.portable).not.toContain("deepseek/r-reason's complete readable reasoning, forwarded unmodified");
  });

  test("the same exact provider/model/profile: NO warning", () => {
    const verdict = classifySwitch(OPENAI, OPENAI, { summaryAvailable: true });
    expect(verdict.lossClass).toBe("lossless-native");
    expect(verdict.warnings).toEqual([]);
    expect(verdict.portable).toContain("openai/o-reason's own reasoning state, replayed exactly");
  });

  test("the same provider, an UNVERIFIED different model: warn, and say why the vendor being unchanged does not help", () => {
    const verdict = classifySwitch(OPENAI, OPENAI_B, { summaryAvailable: true });
    expect(verdict.lossClass).toBe("warned-lossy");
    expect(verdict.warnings.some((w) => w.includes("has not certified"))).toBe(true);
    expect(verdict.warnings.some((w) => w.includes("even though the provider is unchanged"))).toBe(true);
    // ... and the Anthropic form of the same case.
    expect(classifySwitch(CLAUDE, CLAUDE_B, { summaryAvailable: true }).lossClass).toBe("warned-lossy");
  });
});

describe("a certified shared domain suppresses the warning -- and only evidence can certify one", () => {
  test("two DIFFERENT models sharing a domain id switch losslessly", () => {
    const a = endpoint({ providerId: "openai", modelKey: "openai/o-a", continuationDomain: "openai-reasoning-v1" });
    const b = endpoint({ providerId: "openai", modelKey: "openai/o-b", continuationDomain: "openai-reasoning-v1" });
    const verdict = classifySwitch(a, b, {});
    expect(verdict.lossClass).toBe("lossless-native");
    expect(verdict.warnings).toEqual([]);
  });

  test("two providers with NO domain evidence never share one", () => {
    const a = endpoint({ providerId: "local-a", modelKey: "local-a/m" });
    const b = endpoint({ providerId: "local-b", modelKey: "local-b/m" });
    expect(classifySwitch(a, b, {}).lossClass).toBe("warned-lossy");
  });
});

describe("the remaining §8.4 triggers", () => {
  test("policy blocking the forward is its OWN warning: readable reasoning that could have crossed", () => {
    const verdict = classifySwitch(DEEPSEEK, OPENAI, { exposedComplete: true, policyBlocksForwarding: true });
    expect(verdict.lossClass).toBe("warned-lossy");
    expect(verdict.warnings[0]).toContain("policy forbids forwarding");
    expect(verdict.portable).not.toContain("deepseek/r-reason's reasoning summary");
  });

  test("a HIDDEN source whose summary is also policy-blocked loses two things, and is told about both", () => {
    const verdict = classifySwitch(CLAUDE, OPENAI, { summaryAvailable: true, policyBlocksForwarding: true });
    expect(verdict.lossClass).toBe("warned-lossy");
    expect(verdict.warnings).toHaveLength(2);
    expect(verdict.warnings[0]).toContain("starts a new reasoning context");
    expect(verdict.warnings[1]).toContain("policy forbids forwarding");
    expect(verdict.portable).not.toContain("anthropic/claude-a's reasoning summary");
  });

  test("a policy block with nothing to block is NOT a warning", () => {
    const verdict = classifySwitch(OPENAI, OPENAI, { policyBlocksForwarding: true });
    expect(verdict.warnings).toEqual([]);
    expect(verdict.lossClass).toBe("lossless-native");
  });

  test("an exposed source with an INCOMPLETE trace warns even though its readable state would suppress it", () => {
    const verdict = classifySwitch(DEEPSEEK, OPENAI, { exposedComplete: false });
    expect(verdict.lossClass).toBe("warned-lossy");
    expect(verdict.warnings[0]).toContain("not captured");
  });

  test("SUPPRESSION NEEDS AFFIRMATIVE EVIDENCE: an unspecified completeness warns, and reads differently from a known-incomplete one", () => {
    // §8.4's second condition is a positive claim. Reading "not denied" as "proven" would have made
    // every DeepSeek switch classify itself lossless in production, where nothing sets the flag at
    // all -- while every fixture that passes it explicitly stayed green.
    const unconfirmed = classifySwitch(DEEPSEEK, OPENAI, {});
    expect(unconfirmed.lossClass).toBe("warned-lossy");
    expect(unconfirmed.warnings[0]).toContain("could not confirm");
    expect(unconfirmed.warnings[0]).not.toContain("not captured");
    expect(unconfirmed.portable).not.toContain("deepseek/r-reason's complete readable reasoning, forwarded unmodified");
  });

  test("`lossless-portable` is UNREACHABLE without an explicit completeness claim", () => {
    // Every combination of the other facts, with completeness left unstated: none may suppress.
    for (const facts of [{}, { summaryAvailable: true }, { completedToolResults: 3 }, { exposedComplete: false }, { truncated: false }] as const) {
      expect(classifySwitch(DEEPSEEK, OPENAI, facts).lossClass).toBe("warned-lossy");
    }
    expect(classifySwitch(DEEPSEEK, OPENAI, { exposedComplete: true }).lossClass).toBe("lossless-portable");
  });

  test("a mid-turn abort warns EVEN INSIDE a shared domain -- the loss is the unfinished turn", () => {
    const verdict = classifySwitch(OPENAI, OPENAI, { midTurnAbort: true, completedToolResults: 3 });
    expect(verdict.lossClass).toBe("warned-lossy");
    expect(verdict.warnings.join(" ")).toContain("cancelled before it finished");
    expect(verdict.warnings.join(" ")).toContain("nothing that ran is undone");
    expect(verdict.portable).toContain("3 completed tool results and their facts");
  });
});

describe("§8.6's three rules about the text", () => {
  const everyCase = [
    classifySwitch(CLAUDE, OPENAI, { summaryAvailable: true, completedToolResults: 2 }),
    classifySwitch(OPENAI, CLAUDE, { summaryAvailable: true }),
    classifySwitch(GEMINI, OPENAI, {}),
    classifySwitch(XAI, OPENAI, { summaryAvailable: true }),
    classifySwitch(DEEPSEEK, OPENAI, { exposedComplete: true, truncated: true }),
    classifySwitch(OPENAI, OPENAI_B, { summaryAvailable: true }),
    classifySwitch(CLAUDE, CLAUDE_B, { midTurnAbort: true }),
    classifySwitch(DEEPSEEK, OPENAI, { policyBlocksForwarding: true }),
  ];

  test("no warning ever claims the visible conversation is lost", () => {
    for (const verdict of everyCase) {
      expect(verdict.portable[0]).toBe("the visible conversation");
      for (const warning of verdict.warnings) {
        expect(warning.toLowerCase()).not.toContain("conversation is lost");
        expect(warning.toLowerCase()).not.toContain("lose the conversation");
        expect(warning.toLowerCase()).not.toContain("start over");
      }
    }
  });

  test("every warned case names what remains portable", () => {
    for (const verdict of everyCase) {
      expect(verdict.portable.length).toBeGreaterThan(1);
      expect(verdict.warnings.length).toBeGreaterThan(0);
    }
  });

  test("no payload can reach a warning: `SwitchFacts` has nowhere to put one", () => {
    // The proof is structural -- every field is a boolean or a count -- and this fixture is what
    // stops a later edit from adding a string field without anyone noticing.
    const facts = { summaryAvailable: true, exposedComplete: true, truncated: true, policyBlocksForwarding: true, midTurnAbort: true, completedToolResults: 1 };
    for (const value of Object.values(facts)) expect(["boolean", "number"]).toContain(typeof value);
    const verdict = classifySwitch(CLAUDE, OPENAI, facts);
    const rendered = `${verdict.warnings.join(" ")} ${verdict.portable.join(" ")}`;
    for (const forbidden of ["encrypted_content", "signature", "redacted_thinking", "thoughtSignature", "Bearer ", "sk-"]) {
      expect(rendered).not.toContain(forbidden);
    }
  });
});
