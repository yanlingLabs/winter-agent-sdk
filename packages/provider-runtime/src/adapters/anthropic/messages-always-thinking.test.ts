// 2026-10-29 catalog review: MiniMax-M3.1-Flash and Kimi Code's K3.1 Pro models ALWAYS think and answer
// `thinking: {type: "disabled"}` with a 400, so their rows list `thinking.type.disabled` in
// `unsupportedParameters`. The Messages adapter reads that token to OMIT the field (it never refuses the
// whole request), and Kimi's rows send effort as `output_config.effort` via `reasoning.effortRequest`.
// Run against the COMPILED rows, never a hand-built descriptor.
import { describe, expect, test } from "bun:test";
import { buildRequestBody } from "./messages.ts";
import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";

const catalog = loadCatalog();
const compiled = (key: string): WinterModelDescriptor => {
  const row = catalog.models.find((m) => m.key === key);
  if (row === undefined) throw new Error(`fixture: no compiled catalog row ${key}`);
  return row;
};

const ALWAYS_ON = [
  "minimax-anthropic/MiniMax-M3.1-Flash",
  "minimax-cn-anthropic/MiniMax-M3.1-Flash",
  "minimax-token-plan-anthropic/MiniMax-M3.1-Flash",
  "minimax-cn-token-plan-anthropic/MiniMax-M3.1-Flash",
  "kimi-coding/k3.1-pro",
  "kimi-coding/k3.1-pro-highspeed",
  "kimi-coding-intl/k3.1-pro",
  "kimi-coding-intl/k3.1-pro-highspeed",
] as const;

describe("always-thinking rows: a disabled-thinking request omits the field", () => {
  for (const key of ALWAYS_ON) {
    const row = compiled(key);
    test(`${key}: \`thinking: disabled\` is omitted, not sent and not refused`, () => {
      expect(row.unsupportedParameters).toContain("thinking.type.disabled");
      const body = buildRequestBody({ model: row.upstreamId, messages: [{ role: "user", content: "hi" }], thinking: { type: "disabled" } }, row, {});
      expect("thinking" in body).toBe(false);
      expect(body["model"]).toBe(row.upstreamId);
    });

    test(`${key}: an effort request still rides as output_config.effort when the thinking field is omitted`, () => {
      const body = buildRequestBody({ model: row.upstreamId, messages: [{ role: "user", content: "hi" }], thinking: { type: "disabled" }, effort: "low" }, row, {});
      expect("thinking" in body).toBe(false);
      expect(body["output_config"]).toEqual({ effort: "low" });
    });
  }

  test("a K3 row on Kimi Code (served without thinking, not rejected) still forwards `disabled`", () => {
    const row = compiled("kimi-coding/k3");
    const body = buildRequestBody({ model: row.upstreamId, messages: [{ role: "user", content: "hi" }], thinking: { type: "disabled" } }, row, {});
    expect(body["thinking"]).toEqual({ type: "disabled" });
  });
});

describe("Kimi's Anthropic-dialect rows send effort as output_config.effort, not a thinking budget", () => {
  for (const key of ["moonshot-anthropic/kimi-k3.1-pro", "moonshot-cn-anthropic/kimi-k3", "kimi-coding-intl/k3"] as const) {
    test(key, () => {
      const row = compiled(key);
      const body = buildRequestBody({ model: row.upstreamId, messages: [{ role: "user", content: "hi" }], effort: "high" }, row, {});
      expect(body["output_config"]).toEqual({ effort: "high" });
      // Known, disclosed gap (the rows' notes): the adapter pairs the tier with adaptive thinking,
      // which Kimi's request schema does not define. No budget is invented.
      expect(body["thinking"]).toEqual({ type: "adaptive" });
    });
  }
});
