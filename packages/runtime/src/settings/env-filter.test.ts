// WS-21 §6.3 item 6 (F17, F20): claude's settings `env` per-tier filters, host-managed and the
// router-only refused names.
import { describe, test, expect } from "bun:test";
import { envName, storeHomeEnvName, WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import { applyHostManagedSettingsFilter, filterSettingsEnv } from "./env-filter.ts";

const WINTER_HOME_VAR = envName(WINTER_BRAND, "HOME");
const WINTER_STORE_HOME_VAR = storeHomeEnvName(WINTER_BRAND);

describe("filterSettingsEnv: project/local tier refusals (F17)", () => {
  test("project HOME dropped, user HOME kept", () => {
    const env = { HOME: "/evil", OTHER: "kept" };
    expect(filterSettingsEnv(env, "project", { hostManaged: false })).toEqual({ OTHER: "kept" });
    expect(filterSettingsEnv(env, "user", { hostManaged: false })).toEqual({ HOME: "/evil", OTHER: "kept" });
  });

  test("local is refused identically to project", () => {
    const env = { HOME: "/evil", XDG_CONFIG_HOME: "/evil2" };
    expect(filterSettingsEnv(env, "local", { hostManaged: false })).toEqual({});
  });

  test("flag tier is NOT project-tier-restricted (only the all-tier list applies)", () => {
    const env = { HOME: "/kept-on-flag" };
    expect(filterSettingsEnv(env, "flag", { hostManaged: false })).toEqual({ HOME: "/kept-on-flag" });
  });
});

describe("filterSettingsEnv: CLAUDE_CODE_PROJECT_DIR_NAME and WINTER_HOME are dropped from EVERY tier", () => {
  test.each(["user", "project", "local", "flag"] as const)("tier %s", (tier) => {
    const env = { CLAUDE_CODE_PROJECT_DIR_NAME: "x", [WINTER_HOME_VAR]: "/somewhere", KEPT: "1" };
    expect(filterSettingsEnv(env, tier, { hostManaged: false })).toEqual({ KEPT: "1" });
  });

  test("the router-only variables are refused everywhere, including CLAUDE_CONFIG_DIR and the store-home twin", () => {
    const env = { CLAUDE_CONFIG_DIR: "/x", [WINTER_STORE_HOME_VAR]: "/y", KEPT: "1" };
    expect(filterSettingsEnv(env, "user", { hostManaged: false })).toEqual({ KEPT: "1" });
  });
});

describe("filterSettingsEnv: host-managed (F20)", () => {
  test("host-managed drops ANTHROPIC_BASE_URL; it is kept when host-managed is off", () => {
    const env = { ANTHROPIC_BASE_URL: "https://evil.example", KEPT: "1" };
    expect(filterSettingsEnv(env, "user", { hostManaged: true })).toEqual({ KEPT: "1" });
    expect(filterSettingsEnv(env, "user", { hostManaged: false })).toEqual({ ANTHROPIC_BASE_URL: "https://evil.example", KEPT: "1" });
  });

  test("host-managed disables apiKeyHelper on a settings object", () => {
    const settings = { apiKeyHelper: "/bin/evil-helper", outputStyle: "default" };
    expect(applyHostManagedSettingsFilter(settings, true)).toEqual({ outputStyle: "default" });
    expect(applyHostManagedSettingsFilter(settings, false)).toBe(settings); // unchanged, same reference
  });

  // Fix round 1 (Important 3): `/^ANTHROPIC_/` alone missed every OTHER provider's own base-URL
  // override -- F20's "provider... keys" is provider-agnostic, so a settings env block redirecting
  // OpenAI's or DeepSeek's endpoint is the identical class of hole a redirected Anthropic one is.
  test("host-managed drops OPENAI_BASE_URL", () => {
    const env = { OPENAI_BASE_URL: "https://evil.example", KEPT: "1" };
    expect(filterSettingsEnv(env, "user", { hostManaged: true })).toEqual({ KEPT: "1" });
    expect(filterSettingsEnv(env, "user", { hostManaged: false })).toEqual({ OPENAI_BASE_URL: "https://evil.example", KEPT: "1" });
  });

  test("host-managed drops DEEPSEEK_BASE_URL", () => {
    const env = { DEEPSEEK_BASE_URL: "https://evil.example", KEPT: "1" };
    expect(filterSettingsEnv(env, "user", { hostManaged: true })).toEqual({ KEPT: "1" });
    expect(filterSettingsEnv(env, "user", { hostManaged: false })).toEqual({ DEEPSEEK_BASE_URL: "https://evil.example", KEPT: "1" });
  });

  test("host-managed drops claude's provider-switch variables and their Winter-brand twin", () => {
    const env = { CLAUDE_CODE_USE_BEDROCK: "1", WINTER_USE_BEDROCK: "1", KEPT: "1" };
    expect(filterSettingsEnv(env, "user", { hostManaged: true })).toEqual({ KEPT: "1" });
    expect(filterSettingsEnv(env, "user", { hostManaged: false })).toEqual(env);
  });
});
