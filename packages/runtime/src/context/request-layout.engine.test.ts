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
import { attachmentMessage, registerAttachmentRenderer } from "./attachments.ts";
import { getSessionRequestLayout, reloadSessionContext } from "./request-layout.ts";
import { makeGitFixture, type GitFixture } from "./git-fixture.ts";
import { _clearProjectRootCacheForTests, WINTER_MD_BASENAME } from "./winter-md.ts";
import type { SkillListing } from "./seam.ts";

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
