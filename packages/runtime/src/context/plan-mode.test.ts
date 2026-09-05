// Phase 5 Lane C (task 6) -- the plan-mode body (WS-11 §6.6, derived-shapes-p5 item (c)).
import { test, expect, describe } from "bun:test";
import { DEFAULT_PLAN_BODY, PLAN_MODE_ENFORCEMENT, PLAN_MODE_PROTOCOL, renderPlanModeBlock } from "./plan-mode.ts";
import { DEFAULT_PLANS_DIRECTORY } from "@yanlinglabs/winter-agent-sdk";

describe("context/plan-mode.ts", () => {
  test("the default rendering carries the enforcement preamble, the default body and the ExitPlanMode protocol", () => {
    const out = renderPlanModeBlock({ plansDirectory: DEFAULT_PLANS_DIRECTORY });
    expect(out).toContain(PLAN_MODE_ENFORCEMENT);
    expect(out).toContain(DEFAULT_PLAN_BODY);
    expect(out).toContain(PLAN_MODE_PROTOCOL);
    expect(out).toContain("ExitPlanMode");
  });

  test("a hostPlanBody REPLACES the body while the mechanics stay byte-identical (§6.6)", () => {
    const host = renderPlanModeBlock({ plansDirectory: ".winter/plans", hostPlanBody: "HOUSE PLAN RULES" });
    expect(host).toContain("HOUSE PLAN RULES");
    expect(host).not.toContain(DEFAULT_PLAN_BODY);
    // The two fixed halves are unchanged, and still in that order.
    expect(host).toContain(PLAN_MODE_ENFORCEMENT);
    expect(host).toContain(PLAN_MODE_PROTOCOL);
    expect(host.indexOf(PLAN_MODE_ENFORCEMENT)).toBeLessThan(host.indexOf("HOUSE PLAN RULES"));
    expect(host.indexOf("HOUSE PLAN RULES")).toBeLessThan(host.indexOf(PLAN_MODE_PROTOCOL));
  });

  test("a whitespace-only hostPlanBody falls back to the default rather than emptying the section", () => {
    expect(renderPlanModeBlock({ plansDirectory: ".winter/plans", hostPlanBody: "   \n\t " })).toBe(
      renderPlanModeBlock({ plansDirectory: ".winter/plans" }),
    );
  });

  test("the plans directory is named, and it is the caller's value not a hard-coded one", () => {
    expect(renderPlanModeBlock({ plansDirectory: ".winter/plans" })).toContain(".winter/plans");
    expect(renderPlanModeBlock({ plansDirectory: "docs/plans" })).toContain("docs/plans");
    expect(renderPlanModeBlock({ plansDirectory: "docs/plans" })).not.toContain(".winter/plans");
  });

  test("the pinned default plans directory is `.winter/plans` (WS-01 §2.4)", () => {
    expect(DEFAULT_PLANS_DIRECTORY).toBe(".winter/plans");
  });

  test("the enforcement preamble states the read-only rule, not merely a preference", () => {
    expect(PLAN_MODE_ENFORCEMENT.toLowerCase()).toContain("plan mode");
    expect(PLAN_MODE_ENFORCEMENT).toMatch(/withheld|refused|denied|blocked/i);
  });
});
