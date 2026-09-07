import { describe, expect, test } from "bun:test";
import { canonicalModelIdOf, familyIdOf, resolveSlotName, stampFamilyFields, CLAUDE_RESERVED_SLOT_NAMES, SLOT_NAME_RE } from "./families.ts";
import type { ModelFamilyDescriptor } from "./types.ts";

const FAMILIES: ModelFamilyDescriptor[] = [
  { id: "claude", displayName: "Claude", vendor: "Anthropic", vendorProviders: ["anthropic"], matchers: [{ pattern: "^claude-", note: "" }], status: "supported", citation: "spec:WS-13c §9",
    slots: ["fable", "opus", "sonnet", "haiku"].map((name) => ({ name, canonicalModelId: `claude-${name}-x`, description: "d", reason: "r", basis: "winter-curated" as const, citation: "c", status: "candidate" as const })) },
  { id: "gpt-oss", displayName: "GPT-OSS", vendor: "OpenAI", vendorProviders: ["groq"], matchers: [{ pattern: "^gpt-oss-", note: "" }], status: "candidate", citation: "c", slots: [] },
  { id: "gpt", displayName: "GPT", vendor: "OpenAI", vendorProviders: ["codex-oauth", "openai"], matchers: [{ pattern: "^gpt-(?!oss)", note: "" }], status: "candidate", citation: "c",
    slots: [{ name: "astra", canonicalModelId: "gpt-6-astra", description: "d", reason: "r", basis: "user-ruling", citation: "c", status: "candidate" }, { name: "luna", canonicalModelId: "gpt-5.6-luna", description: "d", reason: "r", basis: "user-ruling", citation: "c", status: "candidate" }] },
  { id: "gemini", displayName: "Gemini", vendor: "Google", vendorProviders: ["google"], matchers: [{ pattern: "^gemini-", note: "" }], status: "candidate", citation: "c",
    slots: [{ name: "pro", canonicalModelId: "gemini-3.1-pro-preview", description: "d", reason: "r", basis: "winter-curated", citation: "c", status: "candidate" }, { name: "flash", canonicalModelId: "gemini-3.7-flash", description: "d", reason: "r", basis: "winter-curated", citation: "c", status: "candidate" }] },
  { id: "deepseek", displayName: "DeepSeek", vendor: "DeepSeek", vendorProviders: ["deepseek"], matchers: [{ pattern: "^deepseek", note: "" }], status: "candidate", citation: "c",
    slots: [{ name: "pro", canonicalModelId: "deepseek-v4-pro", description: "d", reason: "r", basis: "winter-curated", citation: "c", status: "candidate" }, { name: "flash", canonicalModelId: "deepseek-v4-flash", description: "d", reason: "r", basis: "winter-curated", citation: "c", status: "candidate" }] },
];

describe("canonicalModelIdOf — the provider's spelling removed, the vendor identity kept", () => {
  test.each([
    ["DeepSeek-V4-Pro", "deepseek-v4-pro"],
    ["us.anthropic.claude-opus-5-v1:0", "claude-opus-5"],
    ["anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4.5-20250929"],
    ["claude-haiku-4-5-20251001", "claude-haiku-4.5-20251001"],
    ["openai/gpt-oss-120b", "gpt-oss-120b"],
    ["MiniMax-M3", "minimax-m3"],
    ["models/gemini-2.5-pro", "gemini-2.5-pro"],
    ["accounts/fireworks/models/deepseek-v4-pro", "deepseek-v4-pro"],
    ["meta-llama/llama-4-scout-17b-16e-instruct", "llama-4-scout-17b-16e-instruct"],
    ["zai-glm-4.7", "glm-4.7"],
    ["gpt-5.6-sol", "gpt-5.6-sol"],
    ["qwen/qwen3.6-27b", "qwen3.6-27b"],
    // R-6c-14 (fix r1, review I-2): the spellings a review measured on the shipped catalog as
    // reaching the right FAMILY with an id no slot could ever equal, plus the gateway forms that
    // were landing in `other` for the same reason.
    ["deepseek/deepseek-v4-pro", "deepseek-v4-pro"], // novita re-namespaces DeepSeek's own ids
    ["qwen3.6:27b", "qwen3.6-27b"], // uncloseai, Ollama's size-tag spelling
    ["openai.gpt-oss-120b-1:0", "gpt-oss-120b"], // bedrock: a NON-`v` version suffix
    ["hf:openai/gpt-oss-120b", "gpt-oss-120b"], // a namespace wrapped around another namespace
    ["cline-pass/glm-5.2", "glm-5.2"],
    ["moonshot/kimi-k2.6", "kimi-k2.6"],
  ])("%s -> %s", (input, expected) => expect(canonicalModelIdOf(input)).toBe(expected));

  // The deliberate NON-changes, pinned so a later widening cannot quietly take them: R-6c-14 rewrites
  // the size tag's SEPARATOR and nothing else. Alibaba's own ids are `qwen3.6` with no hyphen, so
  // inserting one into `gemma4`/`llama3.1` would split a lineup that ships both spellings into two
  // models. These rows stay in `other`, which is the honest answer.
  test.each([
    ["gemma4:31b", "gemma4-31b"],
    ["llama3.1:8b", "llama3.1-8b"],
  ])("%s -> %s (separator only — no hyphen invented into the lineup name)", (input, expected) => expect(canonicalModelIdOf(input)).toBe(expected));
});

describe("familyIdOf — first matcher wins, gpt-oss before gpt, other when nothing matches", () => {
  test("ordering and fallback", () => {
    expect(familyIdOf("gpt-oss-120b", FAMILIES)).toBe("gpt-oss");
    expect(familyIdOf("gpt-oss-120b", [...FAMILIES].reverse())).toBe("gpt-oss"); // order-independent: the patterns are disjoint
    expect(familyIdOf("gpt-6-astra", FAMILIES)).toBe("gpt");
    expect(familyIdOf("claude-opus-5", FAMILIES)).toBe("claude");
    expect(familyIdOf("doubao-seed-2.0", FAMILIES)).toBe("other");
  });
  test("stampFamilyFields honours per-row overrides and never overwrites them", () => {
    const rows = stampFamilyFields([{ upstreamId: "k3", canonicalModelId: "kimi-k3", modelFamily: "kimi" }, { upstreamId: "DeepSeek-V4-Pro" }], FAMILIES);
    expect(rows[0]).toMatchObject({ canonicalModelId: "kimi-k3", modelFamily: "kimi" });
    expect(rows[1]).toMatchObject({ canonicalModelId: "deepseek-v4-pro", modelFamily: "deepseek" });
  });
});

describe("resolveSlotName — active set first, unique foreign names, ambiguity, the Claude reservation", () => {
  test("an active-set name is advertised", () => {
    const r = resolveSlotName("astra", "gpt", FAMILIES);
    expect(r.kind === "slot" && r.advertised && r.family.id === "gpt").toBe(true);
  });
  test("a unique foreign name resolves unadvertised", () => {
    const r = resolveSlotName("luna", "claude", FAMILIES);
    expect(r.kind === "slot" && !r.advertised && r.slot.canonicalModelId === "gpt-5.6-luna").toBe(true);
  });
  test("a foreign name held by two families is ambiguous and names both", () => {
    const r = resolveSlotName("flash", "gpt", FAMILIES);
    expect(r).toEqual({ kind: "ambiguous", name: "flash", candidates: ["gemini/flash", "deepseek/flash"] });
  });
  test("the same name from ITS OWN family is not ambiguous", () => {
    expect(resolveSlotName("flash", "gemini", FAMILIES).kind).toBe("slot");
  });
  test("the four Claude names always resolve into claude", () => {
    for (const name of CLAUDE_RESERVED_SLOT_NAMES) {
      const r = resolveSlotName(name, "gpt", FAMILIES);
      expect(r.kind === "slot" && r.family.id === "claude").toBe(true);
    }
  });
  test("unknown is unknown", () => expect(resolveSlotName("turbo", "gpt", FAMILIES)).toEqual({ kind: "unknown", name: "turbo" }));
  test("the slot token grammar", () => {
    expect(SLOT_NAME_RE.test("grok-4.6")).toBe(true);
    expect(SLOT_NAME_RE.test("Master")).toBe(false);
    expect(SLOT_NAME_RE.test("a".repeat(33))).toBe(false);
  });
});
