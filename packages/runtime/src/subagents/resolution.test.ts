import { describe, test, expect } from "bun:test";
import { resolveModelAlias, UnresolvableModelAliasError, describeRequestedModel, resolveEffort, recordModelEffort } from "./resolution.ts";

describe("resolveModelAlias (WS-10 §3.1)", () => {
  test("with no catalog at all, the requested string passes through unchanged", () => {
    expect(resolveModelAlias("sonnet")).toEqual({ effectiveModel: "sonnet" });
    expect(resolveModelAlias("claude-sonnet-4-5-20250929")).toEqual({ effectiveModel: "claude-sonnet-4-5-20250929" });
  });

  test("a catalog alias maps to a real identifier", () => {
    const catalog = { aliases: { sonnet: "claude-sonnet-4-5-20250929" } };
    expect(resolveModelAlias("sonnet", catalog)).toEqual({ effectiveModel: "claude-sonnet-4-5-20250929" });
  });

  test("an alias with no catalog entry passes through unchanged (no opinion, not a rejection)", () => {
    const catalog = { aliases: { sonnet: "claude-sonnet-4-5-20250929" } };
    expect(resolveModelAlias("opus", catalog)).toEqual({ effectiveModel: "opus" });
  });

  test("availableModels substitution is RECORDED via substitutedFrom, never silent", () => {
    const catalog = { aliases: { opus: "claude-opus-blocked" }, availableModels: ["claude-sonnet-4-5-20250929"], fallbackModel: "claude-sonnet-4-5-20250929" };
    expect(resolveModelAlias("opus", catalog)).toEqual({ effectiveModel: "claude-sonnet-4-5-20250929", substitutedFrom: "claude-opus-blocked" });
  });

  test("an unresolvable alias with no fallback throws a typed error, never a silent substitution", () => {
    const catalog = { availableModels: ["claude-sonnet-4-5-20250929"] };
    expect(() => resolveModelAlias("fable", catalog)).toThrow(UnresolvableModelAliasError);
    try {
      resolveModelAlias("fable", catalog);
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBeInstanceOf(UnresolvableModelAliasError);
      expect((err as UnresolvableModelAliasError).requested).toBe("fable");
    }
  });

  test("a value already IN availableModels needs no substitution", () => {
    const catalog = { availableModels: ["sonnet", "opus"] };
    expect(resolveModelAlias("sonnet", catalog)).toEqual({ effectiveModel: "sonnet" });
  });
});

describe("describeRequestedModel (WS-10 §3.4 record-keeping, descriptive only)", () => {
  test("invocation model wins for description purposes", () => {
    expect(describeRequestedModel({ model: "opus", definition: { model: "haiku" } })).toBe("opus");
  });

  test("definition model is used when the invocation named none", () => {
    expect(describeRequestedModel({ definition: { model: "haiku" } })).toBe("haiku");
  });

  test("'inherit' at either layer is treated as 'nothing specific requested'", () => {
    expect(describeRequestedModel({ model: "inherit", definition: { model: "haiku" } })).toBe("haiku");
    expect(describeRequestedModel({ definition: { model: "inherit" } })).toBeUndefined();
  });

  test("neither present -> undefined (nothing specific was ever asked for)", () => {
    expect(describeRequestedModel({})).toBeUndefined();
  });
});

describe("resolveEffort (WS-10 §3.2)", () => {
  test("a concrete inherited effort is both requested and effective", () => {
    expect(resolveEffort("high")).toEqual({ requestedEffort: "high", effectiveEffort: "high" });
  });

  test("'inherit' (no definition effort was set) has no session-level value to fall back to -- an honest placeholder, not fabricated", () => {
    expect(resolveEffort("inherit")).toEqual({ effectiveEffort: "inherit" });
  });
});

describe("recordModelEffort (WS-10 §3.4 exact 4-field shape)", () => {
  test("all four fields present", () => {
    const rec = recordModelEffort({
      requestedModel: "opus",
      resolved: { effectiveModel: "claude-opus-x", substitutedFrom: "claude-opus-blocked" },
      effort: { requestedEffort: "high", effectiveEffort: "high" },
    });
    expect(rec).toEqual({ requestedModel: "opus", effectiveModel: "claude-opus-x", requestedEffort: "high", effectiveEffort: "high" });
  });

  test("optional fields are OMITTED (never present-as-undefined) when absent", () => {
    const rec = recordModelEffort({ resolved: { effectiveModel: "sonnet" }, effort: { effectiveEffort: "inherit" } });
    expect(rec).toEqual({ effectiveModel: "sonnet", effectiveEffort: "inherit" });
    expect("requestedModel" in rec).toBe(false);
    expect("requestedEffort" in rec).toBe(false);
  });
});
