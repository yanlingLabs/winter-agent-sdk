// WS-23 (midconv) items 2-3: the tool epoch THROUGH THE ENGINE. A scripted provider records every request
// the engine builds; tools come and go in the live registry between turns (a late MCP server, a withdrawn
// tool, a reworded description). Asserted on each request: `tools` is frozen for the epoch (the frozen
// list, then deferred declarations APPENDED, never re-sorted), each change rides an empty-content `system`
// message right after the user turn it follows, every request's messages are a prefix of the next, a
// resumed session rebuilds the epoch from its history, and a refusal falls back once to today's rebuild.
import { afterEach, describe, expect, test } from "bun:test";
import type { PermissionMode, RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { ProviderTurnError, runEngine, type EngineOptions, type ModelDescription, type ProviderMessage, type ProviderRequest, type ProviderTurn } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";
import { registerTool, unregisterToolForTest } from "../tools/registry.ts";
import { fakeCompactionController } from "../compaction/seam.ts";
import { rebuildProviderMessages } from "../store/resume.ts";

const REFERENCE_ROW: ModelDescription = { wire: { deferredToolLoading: true, toolChanges: "reference" } };
const INLINE_ROW: ModelDescription = { wire: { deferredToolLoading: true, toolChanges: "inline" } };

const registered: string[] = [];
afterEach(() => {
  for (const name of registered.splice(0)) unregisterToolForTest(name);
});

/** A test-only eager tool, advertised to every session (or only in `modes`). */
function addTool(name: string, description = `${name}: a midconv test tool`, modes?: PermissionMode[]): void {
  registerTool({
    descriptor: { canonicalName: name, advertisedName: name, source: "sdk", inputSchema: { type: "object", properties: { q: { type: "string" } } }, description, exposure: "eager", permissionClass: "read", availability: modes !== undefined ? { modes } : {}, capabilityRequirements: [], disposition: "implement-now" },
    executor: {
      async execute() {
        return { output: "ok" };
      },
    },
  });
  registered.push(name);
}
function dropTool(name: string): void {
  unregisterToolForTest(name);
  registered.splice(registered.indexOf(name), 1);
}

type Step = { user: string } | { act: () => void } | { control: string; payload: unknown };

async function drive(opts: { describe: ModelDescription; steps: Step[]; generate?: (req: ProviderRequest, index: number) => ProviderTurn | Promise<ProviderTurn>; engine?: Partial<EngineOptions> }): Promise<{ requests: ProviderRequest[]; attachments: Array<{ type: string }>; frames: WinterFrame[] }> {
  const { host, runtime } = createInMemoryChannel();
  const requests: ProviderRequest[] = [];
  const attachments: Array<{ type: string }> = [];
  const done = runEngine({
    config: { sessionId: `midconv-tools-${Math.random().toString(36).slice(2)}`, cwd: "/winter-fixture", model: "anthropic/claude-opus-5-5" } as RuntimeConfig,
    input: runtime.input,
    output: runtime.output,
    provider: {
      async generate(req) {
        requests.push({ ...req, messages: structuredClone(req.messages), ...(req.tools !== undefined ? { tools: structuredClone(req.tools) } : {}) });
        return (await opts.generate?.(req, requests.length - 1)) ?? { kind: "text", text: `reply ${requests.length}` };
      },
    },
    tools: stubExecutor,
    providerIdentity: { providerId: "anthropic", modelKey: "anthropic/claude-opus-5-5", family: "anthropic" },
    describeModel: () => opts.describe,
    store: {
      recordUserEntry() {},
      recordAssistantEntry() {},
      recordAttachmentEntry(a: { type: string }) {
        attachments.push(structuredClone(a));
      },
    },
    ...(opts.engine ?? {}),
  } as EngineOptions);
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  const results = (): number => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").length;
  let users = 0;
  let controls = 0;
  for (const step of opts.steps) {
    if ("act" in step) {
      step.act();
      continue;
    }
    if ("control" in step) {
      const requestId = `c${++controls}`;
      host.output.write({ type: "control_request", requestId, subtype: step.control, payload: step.payload });
      for (let n = 0; n < 2000 && !frames.some((f) => f.type === "control_response" && (f as { requestId: string }).requestId === requestId); n++) await new Promise((r) => setTimeout(r, 2));
      continue;
    }
    host.output.write({ type: "user", text: step.user });
    users++;
    for (let n = 0; n < 3000 && results() < users; n++) await new Promise((r) => setTimeout(r, 2));
  }
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
  return { requests, attachments, frames };
}

const names = (req: ProviderRequest): string[] => (req.tools ?? []).map((t) => t.name);
const changesOf = (req: ProviderRequest) => req.messages.flatMap((m, at) => (m.toolChanges !== undefined ? [{ at, ...m.toolChanges }] : []));
/** `a`'s messages are a byte prefix of `b`'s. */
const isPrefix = (a: ProviderRequest, b: ProviderRequest): boolean => JSON.stringify(b.messages.slice(0, a.messages.length)) === JSON.stringify(a.messages);

describe("the tool epoch, by reference (a row with `midConversationToolChanges`)", () => {
  test("a late tool is declared deferred AFTER the frozen list and announced by reference; a withdrawn one is removed; `tools` never re-sorts; every request prefixes the next", async () => {
    addTool("zz_midconv_a");
    addTool("zz_midconv_b");
    const { requests, attachments } = await drive({
      describe: REFERENCE_ROW,
      steps: [{ user: "one" }, { act: () => addTool("aa_midconv_late") }, { user: "two" }, { act: () => dropTool("zz_midconv_b") }, { user: "three" }],
    });
    expect(requests).toHaveLength(3);
    // Every request opts in (the beta rides all of them), and none restricts by choice.
    expect(requests.map((r) => r.toolChanges)).toEqual([true, true, true]);
    const first = names(requests[0]!);
    expect(first).toContain("zz_midconv_a");
    expect(first).not.toContain("aa_midconv_late");
    // Request 2: the frozen list verbatim, then the late tool declared deferred at the END (never sorted in).
    expect(names(requests[1]!).slice(0, first.length)).toEqual(first);
    expect(requests[1]!.tools!.at(-1)).toMatchObject({ name: "aa_midconv_late", deferLoading: true });
    expect(JSON.stringify(requests[1]!.tools!.slice(0, first.length))).toBe(JSON.stringify(requests[0]!.tools));
    expect(changesOf(requests[1]!)).toEqual([{ at: requests[1]!.messages.length - 1, remove: [], add: [{ type: "reference", name: "aa_midconv_late" }] }]);
    // Request 3: `tools` byte-identical to request 2; the withdrawal rides its own message.
    expect(JSON.stringify(requests[2]!.tools)).toBe(JSON.stringify(requests[1]!.tools));
    expect(changesOf(requests[2]!).map(({ remove, add }) => ({ remove, add }))).toEqual([
      { remove: [], add: [{ type: "reference", name: "aa_midconv_late" }] },
      { remove: ["zz_midconv_b"], add: [] },
    ]);
    // Each change follows the user turn it applies to.
    for (const req of requests) for (const { at } of changesOf(req)) expect(req.messages[at - 1]!.role).toBe("user");
    expect(isPrefix(requests[0]!, requests[1]!)).toBe(true);
    expect(isPrefix(requests[1]!, requests[2]!)).toBe(true);
    // Persisted as additive attachments: the epoch once, then one entry per change.
    expect(attachments.map((a) => a.type)).toEqual(["tool_epoch", "tool_changes", "tool_changes"]);
  });

  test("a RESUMED session rebuilds the epoch and its change log from the history: the same `tools`, the same change messages at the same positions", async () => {
    addTool("zz_midconv_a");
    addTool("zz_midconv_b");
    const first = await drive({ describe: REFERENCE_ROW, steps: [{ user: "one" }, { act: () => addTool("aa_midconv_late") }, { user: "two" }], generate: () => ({ kind: "text", text: "r" }) });
    // The transcript as the run wrote it -- its own attachment payloads, between the user and assistant
    // entries -- rebuilt by the REAL resume reader (the renderer registry must know both types, or the
    // reader drops them and the epoch with them).
    expect(first.attachments.map((a) => a.type)).toEqual(["tool_epoch", "tool_changes"]);
    const at = (uuid: string, parentUuid: string | null) => ({ uuid, parentUuid, timestamp: "2026-09-26T00:00:00.000Z" });
    const entries = [
      { type: "user", ...at("u1", null), message: { role: "user", content: "one" } },
      { type: "attachment", ...at("a1", "u1"), attachment: first.attachments[0] },
      { type: "assistant", ...at("r1", "a1"), message: { id: "m1", role: "assistant", content: [{ type: "text", text: "r" }] } },
      { type: "user", ...at("u2", "r1"), message: { role: "user", content: "two" } },
      { type: "attachment", ...at("a2", "u2"), attachment: first.attachments[1] },
      { type: "assistant", ...at("r2", "a2"), message: { id: "m2", role: "assistant", content: [{ type: "text", text: "r" }] } },
    ];
    const resumed = rebuildProviderMessages(entries as never);
    expect(resumed.filter((m) => m.meta !== undefined).map((m) => m.meta!.attachment.type)).toEqual(["tool_epoch", "tool_changes"]);
    const again = await drive({ describe: REFERENCE_ROW, steps: [{ user: "three" }], engine: { initialMessages: resumed } });
    expect(JSON.stringify(again.requests[0]!.tools)).toBe(JSON.stringify(first.requests[1]!.tools));
    expect(changesOf(again.requests[0]!).map(({ remove, add }) => ({ remove, add }))).toEqual([{ remove: [], add: [{ type: "reference", name: "aa_midconv_late" }] }]);
    // Nothing new to announce, so the resumed request appends no entry of its own.
    expect(again.attachments).toEqual([]);
  });

  test("a CHANGED definition cannot be said by reference: the list is re-sent once as a new epoch, logged once", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(" "));
    try {
      addTool("zz_midconv_a");
      const { requests, attachments } = await drive({
        describe: REFERENCE_ROW,
        steps: [
          { user: "one" },
          {
            act: () => {
              dropTool("zz_midconv_a");
              addTool("zz_midconv_a", "zz_midconv_a: reworded");
            },
          },
          { user: "two" },
        ],
      });
      expect(requests[1]!.tools!.find((t) => t.name === "zz_midconv_a")!.description).toBe("zz_midconv_a: reworded");
      expect(changesOf(requests[1]!)).toEqual([]);
      expect(attachments.map((a) => a.type)).toEqual(["tool_epoch", "tool_epoch"]);
      expect(errors.filter((e) => e.includes("re-sends its tool list"))).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });

  test("the API refusing a tool change falls back ONCE, sticky: the round re-runs on today's live list with no change message, logged once", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(" "));
    try {
      addTool("zz_midconv_a");
      const { requests, frames } = await drive({
        describe: REFERENCE_ROW,
        steps: [{ user: "one" }, { act: () => addTool("aa_midconv_late") }, { user: "two" }, { act: () => addTool("aa_midconv_later") }, { user: "three" }],
        generate: (req) => {
          if (req.messages.some((m) => m.toolChanges !== undefined)) {
            throw new ProviderTurnError("provider request failed (bad_request): HTTP 400 — Unexpected value(s) `mid-conversation-tool-changes-2026-07-01` for the `anthropic-beta` header", { status: 400, code: "bad_request", retryable: false });
          }
          return { kind: "text", text: "ok" };
        },
      });
      // one (opt-in, no change) / two (the change, refused) / two again (rebuilt, no opt-in) / three (rebuilt).
      expect(requests.map((r) => [r.toolChanges ?? false, changesOf(r).length])).toEqual([
        [true, 0],
        [true, 1],
        [false, 0],
        [false, 0],
      ]);
      // Rebuilt means today's list: sorted, the late tools in place, none deferred.
      expect(names(requests[3]!)).toEqual([...names(requests[3]!)].sort());
      expect(names(requests[3]!)).toContain("aa_midconv_later");
      const results = frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").map((f) => (f as { message: { is_error: boolean } }).message.is_error);
      expect(results).toEqual([false, false, false]);
      expect(errors.filter((e) => e.includes("refused a mid-conversation tool change"))).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });

  test("a `pause_turn` resend appends no change (a change never follows a paused assistant turn); the next user turn catches up", async () => {
    addTool("zz_midconv_a");
    const { requests } = await drive({
      describe: REFERENCE_ROW,
      steps: [{ user: "one" }, { user: "two" }],
      generate: (_req, index) => {
        if (index === 0) {
          addTool("aa_midconv_late");
          return { kind: "text", text: "paused", stopReason: "pause_turn" };
        }
        return { kind: "text", text: "ok" };
      },
    });
    expect(requests[1]!.messages.at(-1)!.role).toBe("assistant");
    expect(changesOf(requests[1]!)).toEqual([]);
    expect(changesOf(requests[2]!).map(({ add }) => add)).toEqual([[{ type: "reference", name: "aa_midconv_late" }]]);
  });

  test("a compaction freezes the list afresh: the next request declares the live list and replays no earlier change", async () => {
    addTool("zz_midconv_a");
    const { requests, attachments } = await drive({
      describe: REFERENCE_ROW,
      steps: [{ user: "one" }, { act: () => addTool("aa_midconv_late") }, { user: "two" }, { user: "/compact" }, { user: "three" }],
      engine: { compactionController: fakeCompactionController({ keep: 0, summary: "SUMMARY" }) },
    });
    const last = requests.at(-1)!;
    expect(names(last)).toEqual([...names(last)].sort());
    expect(last.tools!.find((t) => t.name === "aa_midconv_late")?.deferLoading).toBeUndefined();
    expect(changesOf(last)).toEqual([]);
    expect(attachments.filter((a) => a.type === "tool_epoch")).toHaveLength(2);
  });
});

describe("the tool epoch, by value (a row with `inlineToolDefinitions`)", () => {
  test("a late tool and a REDEFINED one ride `tool_definition` additions; `tools` stays byte-identical; the new definition is what the model has", async () => {
    addTool("zz_midconv_a");
    const { requests } = await drive({
      describe: INLINE_ROW,
      steps: [
        { user: "one" },
        { act: () => addTool("aa_midconv_late") },
        { user: "two" },
        {
          act: () => {
            dropTool("zz_midconv_a");
            addTool("zz_midconv_a", "zz_midconv_a: reworded");
          },
        },
        { user: "three" },
      ],
    });
    expect(JSON.stringify(requests[1]!.tools)).toBe(JSON.stringify(requests[0]!.tools));
    expect(JSON.stringify(requests[2]!.tools)).toBe(JSON.stringify(requests[0]!.tools));
    expect(changesOf(requests[2]!).map(({ remove, add }) => ({ remove, add }))).toEqual([
      { remove: [], add: [{ type: "definition", name: "aa_midconv_late", description: "aa_midconv_late: a midconv test tool", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] },
      { remove: [], add: [{ type: "definition", name: "zz_midconv_a", description: "zz_midconv_a: reworded", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] },
    ]);
    expect(isPrefix(requests[0]!, requests[1]!)).toBe(true);
    expect(isPrefix(requests[1]!, requests[2]!)).toBe(true);
  });
});

describe("the documented tool-change errors (inline)", () => {
  test("a 400 `tool_name_conflict` (a definition reusing a server tool's name) falls back once to today's rebuild, like any refused change", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(" "));
    try {
      addTool("zz_midconv_a");
      const { requests } = await drive({
        describe: INLINE_ROW,
        steps: [{ user: "one" }, { act: () => addTool("aa_midconv_late") }, { user: "two" }],
        generate: (req) => {
          if (req.messages.some((m) => m.toolChanges?.add.some((a) => a.type === "definition") === true)) {
            throw new ProviderTurnError('provider request failed (bad_request): HTTP 400 — {"type":"error","error":{"type":"invalid_request_error","message":"tool name is already used by a different type of tool","details":{"error_code":"tool_name_conflict"}}}', { status: 400, code: "bad_request", retryable: false });
          }
          return { kind: "text", text: "ok" };
        },
      });
      expect(requests.map((r) => [r.toolChanges ?? false, changesOf(r).length])).toEqual([
        [true, 0],
        [true, 1],
        [false, 0],
      ]);
      expect(names(requests[2]!)).toContain("aa_midconv_late");
      expect(errors.filter((e) => e.includes("refused a mid-conversation tool change"))).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });
});

describe("the tool epoch on OpenAI (`additionalToolsItem` + `allowedToolsChoice`)", () => {
  const OPENAI_ROW: ModelDescription = { wire: { additionalToolsItem: true, allowedToolsChoice: true } };

  test("a PERMISSION-MODE SWITCH keeps `tools` byte-identical: only the callable subset (`allowed_tools`) changes, and switching back lifts it", async () => {
    addTool("zz_midconv_a");
    addTool("zz_midconv_default_only", "only outside plan mode", ["default"]);
    const { requests } = await drive({
      describe: OPENAI_ROW,
      steps: [{ user: "one" }, { control: "set_permission_mode", payload: "plan" }, { user: "two" }, { control: "set_permission_mode", payload: "default" }, { user: "three" }],
    });
    expect(requests).toHaveLength(3);
    expect(names(requests[0]!)).toContain("zz_midconv_default_only");
    expect(JSON.stringify(requests[1]!.tools)).toBe(JSON.stringify(requests[0]!.tools));
    expect(JSON.stringify(requests[2]!.tools)).toBe(JSON.stringify(requests[0]!.tools));
    expect(requests[0]!.allowedTools).toBeUndefined();
    expect(requests[1]!.allowedTools).toBeDefined();
    expect(requests[1]!.allowedTools).not.toContain("zz_midconv_default_only");
    expect(requests[1]!.allowedTools).toContain("zz_midconv_a");
    expect(requests[2]!.allowedTools).toBeUndefined();
    // No change message: a restriction is a per-request choice, not an entry. OpenAI sends no opt-in.
    expect(requests.flatMap(changesOf)).toEqual([]);
    expect(requests.map((r) => r.toolChanges)).toEqual([undefined, undefined, undefined]);
    expect(isPrefix(requests[0]!, requests[1]!)).toBe(true);
    expect(isPrefix(requests[1]!, requests[2]!)).toBe(true);
  });

  test("a late tool rides an `additional_tools` change (a definition) and `tools` stays byte-identical", async () => {
    addTool("zz_midconv_a");
    const { requests } = await drive({ describe: OPENAI_ROW, steps: [{ user: "one" }, { act: () => addTool("aa_midconv_late") }, { user: "two" }] });
    expect(JSON.stringify(requests[1]!.tools)).toBe(JSON.stringify(requests[0]!.tools));
    expect(changesOf(requests[1]!).map(({ remove, add }) => ({ remove, add }))).toEqual([
      { remove: [], add: [{ type: "definition", name: "aa_midconv_late", description: "aa_midconv_late: a midconv test tool", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] },
    ]);
  });
});

describe("no mechanism", () => {
  test("a row without the evidence keeps today's rebuild: the live list, sorted, no opt-in, no bookkeeping", async () => {
    addTool("zz_midconv_a");
    const { requests, attachments } = await drive({ describe: { wire: { deferredToolLoading: true } }, steps: [{ user: "one" }, { act: () => addTool("aa_midconv_late") }, { user: "two" }] });
    expect(requests.map((r) => r.toolChanges)).toEqual([undefined, undefined]);
    expect(names(requests[1]!)).toEqual([...names(requests[1]!)].sort());
    expect(names(requests[1]!)).toContain("aa_midconv_late");
    expect(attachments).toEqual([]);
  });
});
