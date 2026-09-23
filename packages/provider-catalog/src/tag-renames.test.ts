// WS-21 lane L1b, Task L1b.1 (spec §8 step 5; F23): `CATALOG_TAG_RENAMES` is what lets a host
// canonicalize a STORED old-catalog tag after a reviewed refresh renames the row underneath it --
// without rewriting settings/runtime-state in place (an older Winter's catalog has no row under the
// new spelling, so the rewrite has to be read-time, not a migration).
//
// Pinned by the 2026-09-19 refresh (commit f9c7d6e): DeepSeek's official Models & Pricing page names
// the current V4.1 Flash wire id `deepseek-flash`; the legacy `deepseek-v4-flash` is excluded from the
// upstream layer as a reviewed `modelOverrides` exclusion and shipped instead as an alias of the new
// overlay row, for both DeepSeek dialects (`deepseek`, `deepseek-anthropic`).
import { describe, expect, test } from "bun:test";
import { loadCatalog } from "./index.ts";
import { CATALOG_TAG_RENAMES } from "./tag-renames.ts";

describe("CATALOG_TAG_RENAMES: derived from the reviewed refresh, never hand-typed", () => {
  test("the 2026-09-19 DeepSeek Flash rename resolves for both dialects", () => {
    expect(CATALOG_TAG_RENAMES["deepseek-anthropic/deepseek-v4-flash"]).toBe("deepseek-anthropic/deepseek-flash");
    expect(CATALOG_TAG_RENAMES["deepseek/deepseek-v4-flash"]).toBe("deepseek/deepseek-flash");
  });

  test("every value names a real row of the bundled catalog", () => {
    const keys = new Set(loadCatalog().models.map((m) => m.key));
    for (const newTag of Object.values(CATALOG_TAG_RENAMES)) expect(keys.has(newTag)).toBe(true);
  });

  test("no domain entry is itself a live catalog key -- a rename never shadows a real tag", () => {
    const keys = new Set(loadCatalog().models.map((m) => m.key));
    for (const oldTag of Object.keys(CATALOG_TAG_RENAMES)) expect(keys.has(oldTag)).toBe(false);
  });

  test("a pure exclusion with no surviving alias anywhere (the TTS row) mints no rename -- V16's rule for an undocumented routing", () => {
    expect(Object.keys(CATALOG_TAG_RENAMES).some((k) => k.includes("gemini-3.1-flash-tts-preview"))).toBe(false);
  });

  test("V16: `deepseek-reasoner` is not documented as routed anywhere in the refresh, so it stays unmapped", () => {
    expect(CATALOG_TAG_RENAMES["deepseek/deepseek-reasoner"]).toBeUndefined();
    expect(CATALOG_TAG_RENAMES["deepseek-anthropic/deepseek-reasoner"]).toBeUndefined();
  });
});
