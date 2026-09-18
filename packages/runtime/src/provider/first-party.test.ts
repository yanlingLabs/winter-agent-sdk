// The first-party Anthropic membership, and the ONE table that has to agree with it.
import { describe, expect, test } from "bun:test";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { FIRST_PARTY_ANTHROPIC_PROVIDER_IDS, isFirstPartyAnthropic } from "./first-party.ts";
import { apiProviderFor } from "./session-provider.ts";

describe("isFirstPartyAnthropic", () => {
  test("the two Anthropic-own rows, and nothing else", () => {
    expect(isFirstPartyAnthropic("anthropic")).toBe(true);
    expect(isFirstPartyAnthropic("console")).toBe(true);
    for (const id of ["openai", "codex-oauth", "bedrock", "vertex", "agentrouter", "zai-anthropic", "deepseek-anthropic", "kimi-coding", "cc", "prova", ""]) {
      expect([id, isFirstPartyAnthropic(id)]).toEqual([id, false]);
    }
    expect(isFirstPartyAnthropic(undefined)).toBe(false);
  });

  test("every member is a REAL catalog provider whose endpoint is Anthropic's own", () => {
    const catalog = loadCatalog();
    for (const id of FIRST_PARTY_ANTHROPIC_PROVIDER_IDS) {
      const provider = catalog.providers.find((p) => p.id === id);
      expect([id, provider !== undefined]).toEqual([id, true]);
      expect([id, provider!.defaultEndpoints?.api]).toEqual([id, "https://api.anthropic.com"]);
    }
  });

  test("it is NOT the `family: \"anthropic\"` column, which is a dialect statement -- several third parties are in it", () => {
    const catalog = loadCatalog();
    const dialect = catalog.providers.filter((p) => p.family === "anthropic").map((p) => p.id);
    expect(dialect.length).toBeGreaterThan(FIRST_PARTY_ANTHROPIC_PROVIDER_IDS.size);
    for (const id of FIRST_PARTY_ANTHROPIC_PROVIDER_IDS) expect(dialect).toContain(id);
  });
});

describe("the `AccountInfo.apiProvider` table agrees with it, in both directions", () => {
  test("`firstParty` is reported for exactly the members of the shared set", () => {
    for (const id of FIRST_PARTY_ANTHROPIC_PROVIDER_IDS) expect([id, apiProviderFor(id)]).toEqual([id, "firstParty"]);
    // The other direction: no provider in the whole catalog reports `firstParty` without being a member.
    for (const provider of loadCatalog().providers) {
      if (apiProviderFor(provider.id) === "firstParty") expect(FIRST_PARTY_ANTHROPIC_PROVIDER_IDS.has(provider.id)).toBe(true);
    }
  });
});
