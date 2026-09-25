// WS-23: the hook runner's new behaviour, each form pinned by outcome -- fail-closed, claude's regex
// matchers and lifecycle matcher subjects, the envelope fields and the block-capable interpreters,
// and the loaders that carry `failClosed`/`pluginRoot` onto entries. Engine-level delivery (where
// `additionalContext` lands in a request, Stop continuing a turn) is pinned in
// `engine.ws23-hooks.test.ts`.
import { describe, test, expect } from "bun:test";
import type { HookEvent } from "@yanlinglabs/winter-agent-sdk";
import { buildHookRegistry, type SourcedHookEntry } from "./registry.ts";
import { runHooks, type HookInvoker, type RunHooksContext } from "./runner.ts";
import { buildHookEntriesFromConfig, buildHookEntriesFromSettings } from "./from-config.ts";
import { pluginHookEntries } from "../settings/loaders/hooks.ts";
import { createRegistryToolInputValidator } from "./input-validator.ts";
import { registerTool, unregisterToolForTest, type RegisteredTool } from "../tools/registry.ts";

function reg(id: string, event: HookEvent, matcher?: string, extra: Partial<SourcedHookEntry> = {}): SourcedHookEntry {
  return { id, event, source: "sdk", ...(matcher !== undefined ? { matcher } : {}), ...extra };
}

function ids(entries: SourcedHookEntry[]): string[] {
  return entries.map((e) => e.id);
}

function ctx(entries: SourcedHookEntry[], invoker: HookInvoker, extra: Partial<RunHooksContext> = {}): RunHooksContext {
  return { registry: buildHookRegistry(entries, { trustedWorkspace: true }), invoker, audit: { record: () => {} }, sessionId: "s", policyVersion: 1, ...extra };
}

const answering = (raw: unknown): HookInvoker => ({ invoke: async () => raw });
const throwing = (message: string): HookInvoker => ({
  invoke: async () => {
    throw new Error(message);
  },
});

describe("WS-23 matchers: claude's regex forms beside the existing globs", () => {
  const registry = (matcher: string, warnings: string[] = []) => buildHookRegistry([reg("h", "PreToolUse", matcher)], { warn: (l) => warnings.push(l) });

  test("exact names and the existing `*` / `mcp__srv__*` / `Tool(*)` globs keep working", () => {
    expect(ids(registry("Bash").matching("PreToolUse", "Bash"))).toEqual(["h"]);
    expect(ids(registry("Bash").matching("PreToolUse", "BashOutput"))).toEqual([]);
    expect(ids(registry("*").matching("PreToolUse", "Anything"))).toEqual(["h"]);
    expect(ids(registry("mcp__github__*").matching("PreToolUse", "mcp__github__get_issue"))).toEqual(["h"]);
    expect(ids(registry("mcp__github__*").matching("PreToolUse", "mcp__gitlab__get_issue"))).toEqual([]);
    expect(ids(registry("Bash(*)").matching("PreToolUse", "Bash"))).toEqual(["h"]);
  });

  test("`Edit|Write` matches each alternative and nothing else", () => {
    const r = registry("Edit|Write");
    expect(ids(r.matching("PreToolUse", "Edit"))).toEqual(["h"]);
    expect(ids(r.matching("PreToolUse", "Write"))).toEqual(["h"]);
    expect(ids(r.matching("PreToolUse", "Read"))).toEqual([]);
    // ANCHORED (a stated divergence from claude's unanchored test): `Edit` is not a substring match.
    expect(ids(r.matching("PreToolUse", "NotebookEdit"))).toEqual([]);
  });

  test("`mcp__.*` matches every MCP tool and no built-in", () => {
    const r = registry("mcp__.*");
    expect(ids(r.matching("PreToolUse", "mcp__github__get_issue"))).toEqual(["h"]);
    expect(ids(r.matching("PreToolUse", "Bash"))).toEqual([]);
  });

  test("`.*` matches everything", () => {
    expect(ids(registry(".*").matching("PreToolUse", "Bash"))).toEqual(["h"]);
    expect(ids(registry(".*").matching("PreToolUse", "mcp__x__y"))).toEqual(["h"]);
  });

  test('`""` and an absent matcher both match everything -- and `""` is normalised to absent (not tool-scoped)', () => {
    const r = buildHookRegistry([reg("empty", "PreToolUse", ""), reg("absent", "PreToolUse")]);
    const matched = r.matching("PreToolUse", "Bash");
    expect(ids(matched)).toEqual(["empty", "absent"]);
    expect(matched.every((e) => e.matcher === undefined)).toBe(true);
  });

  test("a pattern that will not compile warns ONCE (at build) and matches nothing", () => {
    const warnings: string[] = [];
    const r = buildHookRegistry([reg("a", "PreToolUse", "Edit|(Write"), reg("b", "PreToolUse", "Edit|(Write")], { warn: (l) => warnings.push(l) });
    expect(ids(r.matching("PreToolUse", "Edit"))).toEqual([]);
    expect(ids(r.matching("PreToolUse", "Write"))).toEqual([]);
    r.matching("PreToolUse", "Edit");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Edit|(Write");
  });

  test("lifecycle subjects: a SessionStart matcher filters on `source` when the runner names one, and matches every group when it does not", () => {
    const r = buildHookRegistry([reg("startup-only", "SessionStart", "startup|resume"), reg("always", "SessionStart")]);
    expect(ids(r.matching("SessionStart", "startup"))).toEqual(["startup-only", "always"]);
    expect(ids(r.matching("SessionStart", "compact"))).toEqual(["always"]);
    expect(ids(r.matching("SessionStart"))).toEqual(["startup-only", "always"]);
  });

  test("runHooks reads the subject from the payload (`source` for SessionStart)", async () => {
    const seen: string[] = [];
    const invoker: HookInvoker = { invoke: async (req) => (seen.push(req.hookId), {}) };
    const entries = [reg("startup-only", "SessionStart", "startup"), reg("always", "SessionStart")];
    await runHooks("SessionStart", { payload: { source: "compact" } }, ctx(entries, invoker));
    expect(seen).toEqual(["always"]);
  });
});

describe("WS-23 fail-closed: opt-in per hook, PreToolUse/PermissionRequest only", () => {
  const call = { toolName: "Bash", toolUseID: "tu", input: { command: "ls" } };

  test("a fail-closed hook that THROWS denies, naming the hook and the failure", async () => {
    const composite = await runHooks("PreToolUse", call, ctx([reg("floor", "PreToolUse", "Bash", { failClosed: true, name: "escapeFloor" })], throwing("boom")));
    expect(composite.decision).toBe("deny");
    expect(composite.message).toContain('"escapeFloor"');
    expect(composite.message).toContain("(hook_error)"); // a failure CODE -- review M3
    expect(composite.message).not.toContain("boom"); // never the thrower's own text
  });

  test("a fail-closed hook that TIMES OUT denies", async () => {
    const hanging: HookInvoker = { invoke: () => new Promise(() => {}) };
    const composite = await runHooks("PreToolUse", call, ctx([reg("floor", "PreToolUse", undefined, { failClosed: true, timeoutMs: 20 })], hanging));
    expect(composite.decision).toBe("deny");
    expect(composite.message).toContain("(timeout)");
  });

  test("a fail-closed hook with MALFORMED output denies (non-object, and a bad permissionDecision)", async () => {
    for (const raw of ["not an object", { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "maybe" } }]) {
      const composite = await runHooks("PreToolUse", call, ctx([reg("floor", "PreToolUse", undefined, { failClosed: true })], answering(raw)));
      expect(composite.decision).toBe("deny");
    }
  });

  test("the deny short-circuits every later hook and the lifecycle frame still reports the hook's error truthfully", async () => {
    const outcomes: string[] = [];
    const seen: string[] = [];
    const invoker: HookInvoker = {
      invoke: async (req) => {
        seen.push(req.hookId);
        if (req.hookId === "floor") throw new Error("crash");
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
      },
    };
    const composite = await runHooks("PreToolUse", call, ctx([reg("floor", "PreToolUse", undefined, { failClosed: true }), reg("later", "PreToolUse")], invoker, { lifecycle: { started: () => {}, response: (i) => outcomes.push(i.outcome) } }));
    expect(composite.decision).toBe("deny");
    expect(seen).toEqual(["floor"]);
    expect(outcomes).toEqual(["error"]);
  });

  test("PermissionRequest honours it too", async () => {
    const composite = await runHooks("PermissionRequest", call, ctx([reg("pr", "PermissionRequest", undefined, { failClosed: true })], throwing("x")));
    expect(composite.decision).toBe("deny");
  });

  test("WITHOUT the opt-in a throwing hook is still a non-blocking error (the default is unchanged)", async () => {
    const composite = await runHooks("PreToolUse", call, ctx([reg("plain", "PreToolUse")], throwing("boom")));
    expect(composite.decision).toBeUndefined();
  });

  test("on an observational event fail-closed means nothing: a throwing PostToolUse hook contributes nothing", async () => {
    const composite = await runHooks("PostToolUse", call, ctx([reg("post", "PostToolUse", undefined, { failClosed: true })], throwing("boom")));
    expect(composite.decision).toBeUndefined();
  });
});

describe("WS-23 interpreters: the envelope fields and the block-capable events", () => {
  test("Stop `decision: block` is a block reason (attributed), and its additionalContext rides beside it", async () => {
    const composite = await runHooks("Stop", { payload: { stop_hook_active: false } }, ctx([reg("s", "Stop")], answering({ decision: "block", reason: "tests are failing", hookSpecificOutput: { hookEventName: "Stop", additionalContext: "run bun test" } })));
    expect(composite.blockReasons).toEqual([{ hookId: "s", context: "tests are failing" }]);
    expect(composite.extraContext?.map((c) => c.context)).toEqual(["run bun test"]);
  });

  test("SubagentStop shares the Stop interpreter", async () => {
    const composite = await runHooks("SubagentStop", {}, ctx([reg("s", "SubagentStop")], answering({ decision: "block", reason: "not done" })));
    expect(composite.blockReasons?.map((b) => b.context)).toEqual(["not done"]);
  });

  test("UserPromptSubmit `decision: block` blocks, and a reasonless block still carries a reason", async () => {
    const withReason = await runHooks("UserPromptSubmit", { payload: { prompt: "x" } }, ctx([reg("u", "UserPromptSubmit")], answering({ decision: "block", reason: "no secrets in prompts" })));
    expect(withReason.blockReasons?.map((b) => b.context)).toEqual(["no secrets in prompts"]);
    const bare = await runHooks("UserPromptSubmit", { payload: { prompt: "x" } }, ctx([reg("u", "UserPromptSubmit")], answering({ decision: "block" })));
    expect(bare.blockReasons?.[0]?.context).toBeTruthy();
  });

  test("an unknown top-level decision on UserPromptSubmit is that hook's error, not a block", async () => {
    const composite = await runHooks("UserPromptSubmit", { payload: { prompt: "x" } }, ctx([reg("u", "UserPromptSubmit")], answering({ decision: "nope" })));
    expect(composite.blockReasons).toBeUndefined();
  });

  test("`continue: false` + stopReason on any event is a preventContinuation, first hook wins", async () => {
    const invoker: HookInvoker = { invoke: async (req) => ({ continue: false, stopReason: `stop from ${req.hookId}` }) };
    const composite = await runHooks("PostToolUse", { toolName: "Bash" }, ctx([reg("a", "PostToolUse"), reg("b", "PostToolUse")], invoker));
    expect(composite.preventContinuation).toEqual({ hookId: "a", reason: "stop from a" });
  });

  test("`systemMessage` accumulates, attributed", async () => {
    const composite = await runHooks("SessionStart", { payload: { source: "startup" } }, ctx([reg("a", "SessionStart")], answering({ systemMessage: "Heads up: prod credentials are loaded" })));
    expect(composite.systemMessages).toEqual([{ hookId: "a", context: "Heads up: prod credentials are loaded" }]);
  });

  test("PostToolUse `decision: block` reaches the MODEL (as context) and still never denies", async () => {
    const composite = await runHooks("PostToolUse", { toolName: "Write" }, ctx([reg("p", "PostToolUse")], answering({ decision: "block", reason: "lint failed: 3 errors", hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "see eslint output" } })));
    expect(composite.decision).toBeUndefined();
    expect(composite.extraContext?.map((c) => c.context)).toEqual(["see eslint output\n\nlint failed: 3 errors"]);
  });

  test("an error outcome carries none of the envelope fields (the §8 failure matrix is unchanged)", async () => {
    const composite = await runHooks("Stop", {}, ctx([reg("s", "Stop")], throwing("x")));
    expect(composite.blockReasons).toBeUndefined();
    expect(composite.preventContinuation).toBeUndefined();
  });
});

describe("WS-23 updatedInput validation against the tool registry's own schema", () => {
  const TOOL = "Ws23SchemaProbe";
  const descriptor = {
    canonicalName: TOOL,
    advertisedName: TOOL,
    source: "builtin",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
    description: "probe",
    exposure: "eager",
    permissionClass: "execute",
    availability: {},
    capabilityRequirements: [],
    disposition: "implement-now",
  } as unknown as RegisteredTool["descriptor"];

  test("a valid transform is accepted; an invalid one is a deny naming the hook; an unknown tool is not held to a schema", async () => {
    registerTool({ descriptor, executor: async () => ({ output: "" }) } as unknown as RegisteredTool);
    try {
      const validator = createRegistryToolInputValidator();
      expect(validator.validate(TOOL, { command: "ls" })).toEqual({ valid: true });
      const bad = validator.validate(TOOL, { command: 1 });
      expect(bad.valid).toBe(false);
      expect(validator.validate("NoSuchTool", { anything: true })).toEqual({ valid: true });

      const composite = await runHooks(
        "PreToolUse",
        { toolName: TOOL, input: { command: "ls" } },
        ctx([reg("rewriter", "PreToolUse")], answering({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "ls", extra: 1 } } }), { validator }),
      );
      expect(composite.decision).toBe("deny");
      expect(composite.transformedInput).toBeUndefined();
      expect(composite.message).toContain('"rewriter"');
    } finally {
      unregisterToolForTest(TOOL);
    }
  });

  test("a schema that does not compile warns once and is not held against the hook", () => {
    const BROKEN = "Ws23BrokenSchema";
    registerTool({ descriptor: { ...descriptor, canonicalName: BROKEN, advertisedName: BROKEN, inputSchema: { $schema: "https://json-schema.org/draft/2019-09/schema", type: "object" } }, executor: async () => ({ output: "" }) } as unknown as RegisteredTool);
    try {
      const warnings: string[] = [];
      const validator = createRegistryToolInputValidator({ warn: (l) => warnings.push(l) });
      expect(validator.validate(BROKEN, { a: 1 })).toEqual({ valid: true });
      expect(validator.validate(BROKEN, { a: 2 })).toEqual({ valid: true });
      expect(warnings).toHaveLength(1);
    } finally {
      unregisterToolForTest(BROKEN);
    }
  });
});

describe("WS-23 loaders: failClosed and pluginRoot reach the entries", () => {
  test("the wire group's failClosed becomes the entry's", () => {
    const entries = buildHookEntriesFromConfig({ PreToolUse: [{ hookCount: 1, source: "sdk", failClosed: true }, { hookCount: 1, source: "sdk" }] });
    expect(entries.map((e) => e.failClosed)).toEqual([true, undefined]);
  });

  test("a settings command handler (or its group) opts in with a literal `true` only", () => {
    const { entries } = buildHookEntriesFromSettings([
      {
        source: "user",
        settings: {
          hooks: {
            PreToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: "a", failClosed: true }, { type: "command", command: "b", failClosed: "yes" }] },
              { matcher: "Write", failClosed: true, hooks: [{ type: "command", command: "c" }] },
            ],
          },
        },
      },
    ]);
    expect(entries.map((e) => [e.command, e.failClosed])).toEqual([
      ["a", true],
      ["b", undefined],
      ["c", true],
    ]);
  });

  test("a plugin's hook entries carry the plugin root", () => {
    const { entries } = pluginHookEntries([{ name: "p", path: "/plugins/p", hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/x.sh" }] }] } } as never]);
    expect(entries[0]?.pluginRoot).toBe("/plugins/p");
    expect(entries[0]?.command).toBe("${CLAUDE_PLUGIN_ROOT}/x.sh"); // substituted at run time, not at load
  });
});

// --- WS-23 fix round 1 -----------------------------------------------------------------------------

describe("WS-23 fix round 1 (M5): claude's matcher semantics", () => {
  const registry = (matcher: string, extra: Partial<SourcedHookEntry> = {}, warnings: string[] = []) =>
    buildHookRegistry([reg("h", "PreToolUse", matcher, extra)], { warn: (l) => warnings.push(l) });

  test("a pattern of only [A-Za-z0-9_|] is exact names -- `Edit` never matches NotebookEdit, `Edit|Write` only those two", () => {
    expect(ids(registry("Edit").matching("PreToolUse", "NotebookEdit"))).toEqual([]);
    expect(ids(registry("Edit").matching("PreToolUse", "Edit"))).toEqual(["h"]);
    expect(ids(registry("Edit|Write").matching("PreToolUse", "NotebookEdit"))).toEqual([]);
    expect(ids(registry("Edit|MultiEdit").matching("PreToolUse", "MultiEdit"))).toEqual(["h"]);
  });

  test("anything else is an UNANCHORED regex test, as in claude: `mcp__.*github` matches mcp__github__create_issue", () => {
    expect(ids(registry("mcp__.*github").matching("PreToolUse", "mcp__github__create_issue"))).toEqual(["h"]);
    expect(ids(registry("^Bash$").matching("PreToolUse", "Bash"))).toEqual(["h"]);
    expect(ids(registry("^Bash$").matching("PreToolUse", "BashOutput"))).toEqual([]);
  });

  test("a FAIL-CLOSED hook whose matcher will not compile runs for EVERY call, with a warning naming it", () => {
    const warnings: string[] = [];
    const r = registry("Edit|(Write", { failClosed: true }, warnings);
    expect(ids(r.matching("PreToolUse", "Bash"))).toEqual(["h"]);
    expect(warnings.some((w) => w.includes("fail-closed") && w.includes("EVERY"))).toBe(true);
  });
});

describe("WS-23 fix round 1 (I2): a fail-closed gating hook is held to a readable shape", () => {
  const call = { toolName: "Bash", toolUseID: "tu", input: { command: "ls" } };
  const closed = (raw: unknown) => runHooks("PreToolUse", call, ctx([reg("floor", "PreToolUse", undefined, { failClosed: true })], answering(raw)));

  test("a hookSpecificOutput naming ANOTHER event (its deny would be ignored) denies", async () => {
    const composite = await closed({ hookSpecificOutput: { hookEventName: "PostToolUse", permissionDecision: "deny" } });
    expect(composite.decision).toBe("deny");
    expect(composite.message).toContain("(malformed_output)");
  });

  test("an `async` answer denies", async () => {
    expect((await closed({ async: true })).decision).toBe("deny");
  });

  test("`{}` is still the floor's ALLOW -- no decision, nothing denied", async () => {
    expect((await closed({})).decision).toBeUndefined();
  });

  test("the same shapes from an ORDINARY hook stay no-opinion (the default is unchanged)", async () => {
    const composite = await runHooks("PreToolUse", call, ctx([reg("plain", "PreToolUse")], answering({ async: true })));
    expect(composite.decision).toBeUndefined();
  });
});

describe("WS-23 fix round 1 (C1): every text contribution is bounded, with a visible marker", () => {
  test("a 5 MB additionalContext / block reason / systemMessage is cut to the bound and says so", async () => {
    const { MAX_HOOK_TEXT_CHARS, hookTruncationMarker } = await import("./bounds.ts");
    const big = "A".repeat(5 * 1024 * 1024);
    const composite = await runHooks("Stop", {}, ctx([reg("s", "Stop")], answering({ decision: "block", reason: big, systemMessage: big, hookSpecificOutput: { hookEventName: "Stop", additionalContext: big } })));
    for (const text of [composite.blockReasons![0]!.context, composite.systemMessages![0]!.context, composite.extraContext![0]!.context] as string[]) {
      expect(text.length).toBe(MAX_HOOK_TEXT_CHARS + hookTruncationMarker(MAX_HOOK_TEXT_CHARS).length);
      expect(text.endsWith(hookTruncationMarker(MAX_HOOK_TEXT_CHARS))).toBe(true);
    }
  });
});

describe("WS-23 fix round 1 (M1): the WebSearch floor and a model's own invalid query", () => {
  test("original {query:'x'} (too short) + the floor's rewrite -> no deny; the call runs with the ORIGINAL so WebSearch reports its own error", async () => {
    await import("../tools/descriptors/index.ts");
    const validator = createRegistryToolInputValidator();
    expect(validator.validate("WebSearch", { query: "x" }).valid).toBe(false); // the premise: the model's own input is already invalid
    const floorRewrite = { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { query: "x", blocked_domains: ["pastebin.com"] } } };
    const composite = await runHooks("PreToolUse", { toolName: "WebSearch", input: { query: "x" } }, ctx([reg("floor", "PreToolUse", "WebSearch", { failClosed: true })], answering(floorRewrite), { validator }));
    expect(composite.decision).toBeUndefined();
    expect(composite.transformedInput).toBeUndefined();
  });

  test("a VALID original + the same rewrite shape stays a valid transform", async () => {
    await import("../tools/descriptors/index.ts");
    const validator = createRegistryToolInputValidator();
    const floorRewrite = { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { query: "news today", blocked_domains: ["pastebin.com"] } } };
    const composite = await runHooks("PreToolUse", { toolName: "WebSearch", input: { query: "news today" } }, ctx([reg("floor", "PreToolUse", "WebSearch", { failClosed: true })], answering(floorRewrite), { validator }));
    expect(composite.decision).toBeUndefined();
    expect(composite.transformedInput).toEqual({ query: "news today", blocked_domains: ["pastebin.com"] });
  });
});
