// SDK 0.0.16 Lane C: the request layout and the persisted attachments, end to end through a real
// `runEngine` with the real assembler. Ground truth is the LIVE provider request.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type ContentBlock, type EngineOptions, type ProviderMessage, type ProviderRequest, type ProviderTurn } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";
import { createSystemPromptAssembler } from "./assembler.ts";
import { attachmentMessage, PLAN_MODE_EXITED_TEXT, registerAttachmentRenderer } from "./attachments.ts";
import { getSessionRequestLayout, reloadSessionContext } from "./request-layout.ts";
import { makeGitFixture, type GitFixture } from "./git-fixture.ts";
import { _clearProjectRootCacheForTests, WINTER_MD_BASENAME } from "./winter-md.ts";
import type { SkillListing } from "./seam.ts";
// WS-24 (I-1): the REAL ExitPlanMode executor, for the one test that needs its own
// `ctx.session.setPermissionMode` -- no test-supplied `tools:` override reaches that seam.
import "../tools/impl/index.ts";

let home: string;
let cwd: string;
beforeEach(() => {
  _clearProjectRootCacheForTests();
  home = mkdtempSync(join(tmpdir(), "winter-layout-home-"));
  cwd = mkdtempSync(join(tmpdir(), "winter-layout-cwd-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

type Script = (req: ProviderRequest, index: number) => ProviderTurn;

interface RunOptions {
  config?: Partial<RuntimeConfig>;
  prompts: string[];
  script?: Script;
  betweenTurns?: (turn: number) => void;
  engine?: Partial<EngineOptions>;
}

async function run(opts: RunOptions): Promise<ProviderRequest[]> {
  const requests: ProviderRequest[] = [];
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: { sessionId: `layout-${Math.random().toString(36).slice(2)}`, cwd, model: "winter-test/layout", ...(opts.config ?? {}) },
    input: runtime.input,
    output: runtime.output,
    provider: {
      async generate(req) {
        requests.push({ ...req, messages: structuredClone(req.messages) });
        return opts.script?.(req, requests.length - 1) ?? { kind: "text", text: "ok" };
      },
    },
    tools: stubExecutor,
    systemPromptAssembler: createSystemPromptAssembler({ home, settings: () => ({}) }),
    ...(opts.engine ?? {}),
  });
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  const results = (): number => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").length;
  for (let i = 0; i < opts.prompts.length; i++) {
    host.output.write({ type: "user", text: opts.prompts[i]! });
    for (let n = 0; n < 600 && results() < i + 1; n++) await new Promise((r) => setTimeout(r, 5));
    if (i < opts.prompts.length - 1) opts.betweenTurns?.(i + 1);
  }
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
  return requests;
}

function texts(message: ProviderMessage | undefined): string[] {
  if (message === undefined) return [];
  if (typeof message.content === "string") return [message.content];
  return message.content.flatMap((b: ContentBlock) => (b.type === "text" ? [b.text] : b.type === "tool_result" && typeof b.content === "string" ? [b.content] : []));
}

const allTexts = (req: ProviderRequest): string[] => req.messages.flatMap(texts);
const count = (req: ProviderRequest, needle: string): number => allTexts(req).filter((t) => t.includes(needle)).length;
const SKILLS_HEADER = "The following skills are available for use with the Skill tool:";
const AGENTS_HEADER = "Available agent types for the Agent tool:";

describe("skill_listing (claude's session state)", () => {
  test("sent once, a new skill is a delta of only that skill, and nothing is re-sent", async () => {
    let listing: SkillListing = [{ name: "alpha", description: "Alpha skill.", source: "project" }];
    const requests = await run({
      prompts: ["one", "two", "three"],
      betweenTurns: (turn) => {
        if (turn === 1) listing = [...listing, { name: "beta", description: "Beta skill.", source: "user" }];
      },
      engine: { skillListing: () => listing },
    });
    expect(count(requests[0]!, SKILLS_HEADER)).toBe(1);
    // (followed by the index-0 context, so claude's merge gives it one trailing newline)
    expect(allTexts(requests[0]!).find((t) => t.includes(SKILLS_HEADER))).toBe(`<system-reminder>\n${SKILLS_HEADER}\n\n- alpha: Alpha skill.\n</system-reminder>\n`);
    // Turn 2: the delta rides the new turn; the turn-1 listing is still there, unchanged.
    expect(count(requests[1]!, SKILLS_HEADER)).toBe(2);
    expect(texts(requests[1]!.messages.at(-1))).toEqual([`<system-reminder>\n${SKILLS_HEADER}\n\n- beta: Beta skill.\n</system-reminder>\n`, "two"]);
    // Turn 3: nothing new.
    expect(count(requests[2]!, SKILLS_HEADER)).toBe(2);
    expect(texts(requests[2]!.messages.at(-1))).toEqual(["three"]);
  });

  test("resume: persisted names seed the sent set -- no re-announce, and only a genuinely new skill is sent (not as initial)", async () => {
    const seeded = attachmentMessage({ type: "skill_listing", content: "- alpha: Alpha skill.", skillCount: 1, isInitial: true, names: ["alpha"] })!;
    const history: ProviderMessage[] = [{ role: "user", content: "earlier" }, seeded, { role: "assistant", content: "earlier reply" }];
    const same = await run({ prompts: ["next"], engine: { initialMessages: history, skillListing: [{ name: "alpha", description: "Alpha skill.", source: "project" }] } });
    expect(count(same[0]!, SKILLS_HEADER)).toBe(1);

    const recorded: Array<{ type: string; [k: string]: unknown }> = [];
    const grown = await run({
      prompts: ["next"],
      engine: {
        initialMessages: history,
        skillListing: [
          { name: "alpha", description: "Alpha skill.", source: "project" },
          { name: "gamma", description: "Gamma.", source: "project" },
        ],
        store: { recordUserEntry: () => {}, recordAssistantEntry: () => {}, recordAttachmentEntry: (a) => void recorded.push(a) },
      },
    });
    expect(count(grown[0]!, SKILLS_HEADER)).toBe(2);
    const skillEntry = recorded.find((a) => a.type === "skill_listing")!;
    expect(skillEntry).toEqual({ type: "skill_listing", content: "- gamma: Gamma.", skillCount: 1, isInitial: false, names: ["gamma"] });
  });

  test("a legacy persisted listing without names suppresses the next listing (claude's suppressNext)", async () => {
    const legacy: ProviderMessage = { role: "user", content: "<system-reminder>\nold\n</system-reminder>", meta: { attachment: { type: "skill_listing", content: "- alpha" } } };
    const requests = await run({ prompts: ["next"], engine: { initialMessages: [{ role: "user", content: "earlier" }, legacy, { role: "assistant", content: "r" }], skillListing: [{ name: "alpha", description: "A.", source: "project" }] } });
    expect(count(requests[0]!, SKILLS_HEADER)).toBe(0);
  });

  test("withheld when the Skill tool is not advertised", async () => {
    const requests = await run({ prompts: ["one"], config: { disallowedTools: ["Skill"] }, engine: { skillListing: [{ name: "alpha", description: "A.", source: "project" }] } });
    expect(count(requests[0]!, SKILLS_HEADER)).toBe(0);
  });
});

describe("compaction", () => {
  test("re-announces the agent listing as INITIAL, keeps the skill state (no re-announce), and rebuilds the context", async () => {
    let compacted = false;
    let generated = 0;
    const recorded: Array<{ type: string; [k: string]: unknown }> = [];
    const requests = await run({
      prompts: ["one", "two"],
      script: () => {
        generated++;
        return { kind: "text", text: "ok" };
      },
      engine: {
        skillListing: [{ name: "alpha", description: "A.", source: "project" }],
        store: { recordUserEntry: () => {}, recordAssistantEntry: () => {}, recordAttachmentEntry: (a) => void recorded.push(a) },
        compactionController: {
          // Compacts once, on the SECOND envelope (after one generation has run).
          shouldCompact: () => !compacted && generated > 0,
          async compact() {
            compacted = true;
            return { summary: "SUMMARY", retained: [], preTokens: 1, evidencedToolNames: [] };
          },
        },
      },
    });
    expect(compacted).toBe(true);
    const post = requests[1]!;
    // Everything (the envelope's own prompt included) folded into the summary: one merged message of
    // [the re-announced listing, the rebuilt context, the summary].
    expect(post.messages).toHaveLength(1);
    expect(count(post, AGENTS_HEADER)).toBe(1);
    expect(count(post, SKILLS_HEADER)).toBe(0);
    expect(texts(post.messages[0]).at(-1)).toBe("SUMMARY");
    const listings = recorded.filter((a) => a.type === "agent_listing_delta");
    expect(listings.map((a) => a["isInitial"])).toEqual([true, true]);
    expect(recorded.filter((a) => a.type === "skill_listing")).toHaveLength(1);
  });
});

describe("date_change (claude's alr)", () => {
  test("announced once when the local date moves past the context's date; the context keeps its date until compaction", async () => {
    let now = new Date(2026, 8, 17, 23, 59);
    const requests = await run({
      prompts: ["one", "two", "three"],
      betweenTurns: () => {
        now = new Date(2026, 8, 18, 0, 1);
      },
      engine: { now: () => now },
    });
    const ctx = (req: ProviderRequest): string => allTexts(req).find((t) => t.includes("# currentDate"))!;
    expect(ctx(requests[0]!)).toContain("Today's date is 2026-09-17.");
    expect(ctx(requests[1]!)).toContain("Today's date is 2026-09-17.");
    const changed = "The date has changed. Today's date is now 2026-09-18.";
    expect(count(requests[0]!, changed)).toBe(0);
    expect(count(requests[1]!, changed)).toBe(1);
    expect(texts(requests[1]!.messages.at(-1))[0]).toContain(changed);
    // Never announced twice.
    expect(count(requests[2]!, changed)).toBe(1);
    // The system prompt never carries the date.
    expect(requests[1]!.system).not.toContain("2026-09-1");
  });
});

describe("gitStatus and omitProjectContext (Explore/Plan)", () => {
  let fx: GitFixture;
  beforeAll(() => {
    fx = makeGitFixture();
    writeFileSync(join(fx.main, WINTER_MD_BASENAME), "REPO RULES");
  });
  afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

  test("the snapshot is the LAST part of the org block; claudeMd carries the repo's instructions file", async () => {
    const requests = await run({ prompts: ["one"], config: { cwd: fx.main } });
    const req = requests[0]!;
    const blocks = req.systemBlocks!;
    expect(blocks.map((b) => b.cacheScope)).toEqual(["global", "org"]);
    const org = blocks[1]!.text;
    const at = org.lastIndexOf("\n\ngitStatus: ");
    expect(at).toBeGreaterThan(0);
    expect(org.slice(at)).toContain("Current branch: trunk");
    expect(org.slice(at)).toMatch(/Recent commits:\n[0-9a-f]+ seed$/);
    expect(org).toContain(" - Is a git repository: true");
    expect(req.system).toBe(blocks.map((b) => b.text).join("\n\n"));
    expect(count(req, "(project instructions, checked into the codebase):\n\nREPO RULES")).toBe(1);
  });

  test("omitProjectContext drops claudeMd and gitStatus, and nothing else", async () => {
    const requests = await run({ prompts: ["one"], config: { cwd: fx.main }, engine: { omitProjectContext: true } });
    const req = requests[0]!;
    expect(req.system).not.toContain("gitStatus:");
    expect(count(req, "REPO RULES")).toBe(0);
    expect(count(req, "# claudeMd")).toBe(0);
    expect(count(req, "# currentDate")).toBe(1);
    expect(req.system).toContain("# Environment");
  });

  test("excludeDynamicSections: the snapshot becomes the FIRST index-0 entry, ahead of claudeMd, and leaves the system prompt", async () => {
    const requests = await run({ prompts: ["one"], config: { cwd: fx.main, systemPrompt: { type: "preset", preset: "claude_code", excludeDynamicSections: true } } });
    const req = requests[0]!;
    expect(req.system).not.toContain("gitStatus");
    expect(req.system).not.toContain(fx.main);
    const ctx = allTexts(req).find((t) => t.includes("As you answer the user's questions"))!;
    expect([...ctx.matchAll(/^# (.+)$/gm)].map((m) => m[1])).toEqual(["gitStatus", "claudeMd", "currentDate", "Environment", "auto memory"]);
    expect(ctx).toContain("# gitStatus\nThis git status was captured when the session began");
  });

  test("the kill switch drops gitStatus", async () => {
    const requests = await run({ prompts: ["one"], config: { cwd: fx.main }, engine: { env: { ...process.env, WINTER_DISABLE_GIT_INSTRUCTIONS: "1" } } });
    expect(requests[0]!.system).not.toContain("gitStatus:");
  });

  test("the snapshot is memoized: a change on disk is not seen until the context is reloaded", async () => {
    const sessionId = "layout-reload-probe";
    const requests = await run({
      prompts: ["one", "two", "three"],
      config: { cwd: fx.main, sessionId },
      betweenTurns: (turn) => {
        writeFileSync(join(fx.main, `new-${turn}.txt`), "x");
        if (turn === 2) expect(reloadSessionContext(sessionId)).toBe(true);
      },
    });
    expect(requests[0]!.system).toContain("Status:\n?? WINTER.md");
    expect(requests[1]!.system).toBe(requests[0]!.system);
    expect(requests[2]!.system).toContain("?? new-1.txt");
    expect(requests[2]!.system).toContain("?? new-2.txt");
    expect(reloadSessionContext(sessionId)).toBe(false); // torn down with the session
    rmSync(join(fx.main, "new-1.txt"));
    rmSync(join(fx.main, "new-2.txt"));
  });
});

describe("mid-turn attachments (claude's scan after every tool round)", () => {
  test("an agent definition added during a tool round is announced right after its results, folded into the tool result", async () => {
    const requests = await run({
      prompts: ["go"],
      config: { winterHome: home, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
      engine: {
        winterHome: home,
        tools: {
          async execute() {
            mkdirSync(join(home, "agents"), { recursive: true });
            writeFileSync(join(home, "agents", "mid-turn.md"), "---\nname: mid-turn\ndescription: arrived mid-turn\n---\nBody.");
            return { output: "wrote it" };
          },
        },
      },
      script: (_req, i) => (i === 0 ? { kind: "tool_use", calls: [{ id: "t1", name: "Read", input: { file_path: "/nonexistent" } }] } : { kind: "text", text: "done" }),
    });
    const toolTurn = requests[1]!.messages.at(-1)!;
    expect(toolTurn.role).toBe("tool");
    const blocks = toolTurn.content as ContentBlock[];
    expect(blocks).toHaveLength(1);
    const result = blocks[0] as Extract<ContentBlock, { type: "tool_result" }>;
    expect(result.content).toBe(
      "wrote it\n\n<system-reminder>\nNew agent types are now available for the Agent tool:\n- mid-turn: arrived mid-turn (Tools: All tools)\n</system-reminder>",
    );
  });
});

describe("the reusable doors", () => {
  test("attachmentProducers: a lane's attachment is appended, persisted, rendered and placed like the built-ins", async () => {
    registerAttachmentRenderer("lane-c-engine-probe", (a) => `probe ${String(a["n"])}`);
    const recorded: Array<{ type: string; [k: string]: unknown }> = [];
    const phases: string[] = [];
    const requests = await run({
      prompts: ["one"],
      config: { disallowedTools: ["Agent"] },
      engine: {
        store: { recordUserEntry: () => {}, recordAssistantEntry: () => {}, recordAttachmentEntry: (a) => void recorded.push(a) },
        attachmentProducers: [
          ({ phase }) => {
            phases.push(phase);
            return phase === "turn-start" ? [{ type: "lane-c-engine-probe", n: 1 }] : [];
          },
        ],
      },
    });
    expect(phases).toEqual(["turn-start"]);
    expect(recorded).toEqual([{ type: "lane-c-engine-probe", n: 1 }]);
    expect(texts(requests[0]!.messages[0])[0]).toBe("<system-reminder>\nprobe 1\n</system-reminder>\n");
  });

  test("the last request's layout is readable per session (for the fork lane), and cleared at teardown", async () => {
    const sessionId = "layout-registry-probe";
    let seen: ReturnType<typeof getSessionRequestLayout>;
    await run({
      prompts: ["one"],
      config: { sessionId },
      script: () => {
        seen = getSessionRequestLayout(sessionId);
        return { kind: "text", text: "ok" };
      },
    });
    expect(seen!.systemBlocks.map((b) => b.cacheScope)).toEqual(["global", "org"]);
    expect(seen!.userContext.map(([k]) => k)).toEqual(["currentDate"]);
    expect(seen!.tools.length).toBeGreaterThan(0);
    expect(getSessionRequestLayout(sessionId)).toBeUndefined();
  });
});

// WS-24 (I-1 fix round): plan mode as a persisted attachment (`context/attachments.ts`'s `plan_mode`),
// replacing the old inline system-prompt block. `system`/`tools` must stay byte-identical across a
// toggle now -- the whole point of the move: the old inline block busted the WHOLE downstream prefix
// on EVERY toggle, on every provider, because it sat ahead of the conversation history rather than
// after it (WS-24 follow-up 8's confirmed live finding). This describe block is
// `seam.contract.test.ts`'s retired "planMode reflects THIS run's live permission mode" test, one
// level down: against the live request, not the assembler's input.
describe("plan_mode (WS-24 I-1)", () => {
  const PLAN_HEADER = "## Plan mode";

  /** A small harness with control-request access -- plan mode is driven by `set_permission_mode`, not by a prompt alone. `run()` above has no door for that. */
  async function driveControlled(opts: {
    config?: Partial<RuntimeConfig>;
    engine?: Partial<EngineOptions>;
    script?: Script;
    steps: Array<{ user: string } | { control: string; payload: unknown }>;
    /**
     * WS-24: the mid-turn ExitPlanMode test needs the REAL tool registry (its executor's
     * `ctx.session.setPermissionMode`, which no test-supplied `tools:` override can reach -- that
     * seam takes only `{id,name,input}`, no session context at all). Every other test here runs
     * under `bypassPermissions` against the stub, which never needs one.
     */
    realTools?: boolean;
  }): Promise<{ requests: ProviderRequest[]; frames: WinterFrame[] }> {
    const requests: ProviderRequest[] = [];
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: { sessionId: `layout-plan-${Math.random().toString(36).slice(2)}`, cwd, model: "winter-test/layout", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, ...(opts.config ?? {}) },
      input: runtime.input,
      output: runtime.output,
      provider: {
        async generate(req) {
          requests.push({ ...req, messages: structuredClone(req.messages) });
          return opts.script?.(req, requests.length - 1) ?? { kind: "text", text: "ok" };
        },
      },
      ...(opts.realTools === true ? {} : { tools: stubExecutor }),
      systemPromptAssembler: createSystemPromptAssembler({ home, settings: () => ({}) }),
      ...(opts.engine ?? {}),
    } as EngineOptions);
    const frames: WinterFrame[] = [];
    const reader = (async () => {
      for await (const f of host.input) {
        frames.push(f);
        // WS-24: auto-approve any live permission prompt -- needed for the real ExitPlanMode
        // executor (a `mode`-class tool) to actually run under a genuinely live "plan" mode.
        if (f.type === "control_request" && (f as { subtype?: unknown }).subtype === "permission") {
          host.output.write({ type: "control_response", requestId: (f as { requestId: string }).requestId, ok: true, payload: { behavior: "allow" } });
        }
      }
    })();
    const results = (): number => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").length;
    let users = 0;
    let controls = 0;
    for (const step of opts.steps) {
      if ("control" in step) {
        const requestId = `c${++controls}`;
        host.output.write({ type: "control_request", requestId, subtype: step.control, payload: step.payload });
        for (let n = 0; n < 500 && !frames.some((f) => f.type === "control_response" && (f as { requestId: string }).requestId === requestId); n++) await new Promise((r) => setTimeout(r, 2));
        continue;
      }
      host.output.write({ type: "user", text: step.user });
      users++;
      for (let n = 0; n < 600 && results() < users; n++) await new Promise((r) => setTimeout(r, 5));
    }
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    await done;
    await reader;
    return { requests, frames };
  }

  test("entering plan mode: system and tools stay byte-identical across the toggle; the notice appears exactly once, never repeated on later turns", async () => {
    const { requests } = await driveControlled({
      steps: [{ user: "one" }, { control: "set_permission_mode", payload: "plan" }, { user: "two" }, { user: "three" }],
    });
    expect(requests).toHaveLength(3);
    expect(requests[1]!.system).toBe(requests[0]!.system);
    expect(requests[2]!.system).toBe(requests[0]!.system);
    expect(JSON.stringify(requests[1]!.tools)).toBe(JSON.stringify(requests[0]!.tools));
    expect(count(requests[0]!, PLAN_HEADER)).toBe(0);
    expect(count(requests[1]!, PLAN_HEADER)).toBe(1);
    // Persisted in history, so it rides every LATER request too -- but never a second copy.
    expect(count(requests[2]!, PLAN_HEADER)).toBe(1);
  });

  test("leaving plan mode via a host/UI switch (no tool call): the exited notice appears once, and system/tools are unaffected by either transition", async () => {
    const { requests } = await driveControlled({
      steps: [
        { user: "one" },
        { control: "set_permission_mode", payload: "plan" },
        { user: "two" },
        { control: "set_permission_mode", payload: "default" },
        { user: "three" },
        { user: "four" },
      ],
    });
    expect(requests).toHaveLength(4);
    expect(count(requests[1]!, PLAN_HEADER)).toBe(1);
    expect(count(requests[2]!, PLAN_MODE_EXITED_TEXT)).toBe(1);
    expect(count(requests[3]!, PLAN_MODE_EXITED_TEXT)).toBe(1); // persisted, never repeated
    expect(requests[3]!.system).toBe(requests[0]!.system);
  });

  test("a compaction while plan mode is ACTIVE re-announces it -- a summary would otherwise be the last word on it", async () => {
    let compacted = false;
    let generated = 0;
    const { requests } = await driveControlled({
      steps: [{ user: "one" }, { control: "set_permission_mode", payload: "plan" }, { user: "two" }],
      script: () => {
        generated++;
        return { kind: "text", text: "ok" };
      },
      engine: {
        compactionController: {
          // Compacts once, right after turn one's generation -- so turn two's own request is the
          // POST-compaction one, with plan mode already live.
          shouldCompact: () => !compacted && generated > 0,
          async compact() {
            compacted = true;
            return { summary: "SUMMARY", retained: [], preTokens: 1, evidencedToolNames: [] };
          },
        },
      },
    });
    expect(compacted).toBe(true);
    const post = requests[1]!;
    expect(post.messages).toHaveLength(1); // everything folded into the one summary message
    expect(count(post, PLAN_HEADER)).toBe(1);
    expect(texts(post.messages[0]).at(-1)).toBe("SUMMARY");
  });

  test("a resumed session whose history's last word differs from its live mode catches up on its first turn", async () => {
    // Stands in for a real resume: `initialMessages` is exactly what a resumed session's history is
    // seeded with (`store/resume.ts`'s own door into the engine) -- the mechanism under test is the
    // FOLD reacting to a mismatch, not the disk round trip that produces one. The history's last word
    // is "entered"; the live mode this run actually starts under is `bypassPermissions` (the user left
    // plan mode, or the session resumes under a different mode, while it was stopped).
    const entered = attachmentMessage({ type: "plan_mode", state: "entered", plansDirectory: ".winter/plans" })!;
    const { requests } = await driveControlled({
      engine: { initialMessages: [{ role: "user", content: "earlier" }, entered] },
      steps: [{ user: "one" }],
    });
    expect(requests).toHaveLength(1);
    expect(count(requests[0]!, PLAN_MODE_EXITED_TEXT)).toBe(1);
  });

  test("a mid-turn ExitPlanMode approval (the REAL executor, genuinely live plan mode) emits the exited notice in the SAME tool round, right after the tool result", async () => {
    const { requests } = await driveControlled({
      realTools: true,
      config: { permissionMode: "plan" },
      steps: [{ user: "go" }],
      script: (_req, i) => (i === 0 ? { kind: "tool_use", calls: [{ id: "t1", name: "ExitPlanMode", input: { plan: "do the thing" } }] } : { kind: "text", text: "done" }),
    });
    expect(requests).toHaveLength(2);
    // A session that starts DIRECTLY in plan mode gets the entered notice on its very first
    // turn-start scan too -- there is no session state before the first generation for the fold to
    // have compared against, so "live=plan, history=exited (the default)" is already a difference.
    expect(count(requests[0]!, PLAN_HEADER)).toBe(1);
    const toolTurn = requests[1]!.messages;
    const toolIndex = toolTurn.findIndex((m) => m.role === "tool");
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    // The notice arrives in THIS round's own request -- not delayed to the next turn-start scan.
    // (Folded into the tool result's own content, the SAME tool-round placement `queued_command`
    // task notifications get -- `scanAttachments`'s own header on the mid-turn delivery -- rather
    // than a separate top-level message; the text is present exactly once either way.)
    expect(count(requests[1]!, PLAN_MODE_EXITED_TEXT)).toBe(1);
    expect(texts(toolTurn[toolIndex]).some((t) => t.includes(PLAN_MODE_EXITED_TEXT))).toBe(true);
  });
});
