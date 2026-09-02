import { describe, test, expect } from "bun:test";
import { buildHookEntriesFromConfig } from "./from-config.ts";

describe("buildHookEntriesFromConfig", () => {
  test("absent config -> no entries", () => {
    expect(buildHookEntriesFromConfig(undefined)).toEqual([]);
  });

  test("one event, one group, two hooks -- positional ids match query.ts's own formula, names threaded when present", () => {
    const entries = buildHookEntriesFromConfig({
      PreToolUse: [{ matcher: "Bash", hookCount: 2, timeoutSec: 45, source: "sdk", hookNames: ["myHook", null] }],
    });
    expect(entries).toEqual([
      { id: "PreToolUse:sdk:0:0", name: "myHook", event: "PreToolUse", matcher: "Bash", source: "sdk", timeoutMs: 45_000 },
      { id: "PreToolUse:sdk:0:1", event: "PreToolUse", matcher: "Bash", source: "sdk", timeoutMs: 45_000 },
    ]);
  });

  test("multiple groups across events produce distinct positional ids", () => {
    const entries = buildHookEntriesFromConfig({
      PreToolUse: [{ hookCount: 1, source: "sdk" }, { hookCount: 1, source: "sdk" }],
      SessionStart: [{ hookCount: 1, source: "sdk" }],
    });
    expect(entries.map((e) => e.id)).toEqual(["PreToolUse:sdk:0:0", "PreToolUse:sdk:1:0", "SessionStart:sdk:0:0"]);
  });

  test("an unrecognized event name is silently skipped -- accepted+preserved+INERT (WS-08 §1), never registered as a matchable participant", () => {
    const entries = buildHookEntriesFromConfig({
      PreToolUse: [{ hookCount: 1, source: "sdk" }],
      SomeFutureOrMisspelledEventName: [{ hookCount: 3, source: "user" }],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.event).toBe("PreToolUse");
  });

  test("timeoutSec absent -> timeoutMs absent (registry/runner fall back to the event-classification default)", () => {
    const entries = buildHookEntriesFromConfig({ PreToolUse: [{ hookCount: 1, source: "sdk" }] });
    expect("timeoutMs" in entries[0]!).toBe(false);
  });

  test("a filesystem-sourced (non-sdk) group is source-agnostic: converts identically, even though no real producer exists yet at P2", () => {
    const entries = buildHookEntriesFromConfig({ PreToolUse: [{ hookCount: 1, source: "managed" }] });
    expect(entries).toEqual([{ id: "PreToolUse:managed:0:0", event: "PreToolUse", source: "managed" }]);
  });
});
