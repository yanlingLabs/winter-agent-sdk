// WS-23 (reasoning-state) item 1: Anthropic thinking moves OUT of the transcript into the provider-state
// sidecar, and the request the endpoint receives must not change by a single byte -- the cached prefix
// is the whole point.
//
// THE PROOF IS A GOLDEN CAPTURED BEFORE THE MOVE. `reasoning-blocks-wire.golden.json` holds the request
// messages a real session sent on the commit that still wrote thinking inline (ws23/midconv fd40716,
// regenerated only with `WINTER_UPDATE_REASONING_GOLDEN=1`), and the transcript + sidecar that session
// left on disk. The live run, the resumed run and a resume of that pre-move transcript must all
// reproduce those bytes. A real engine drives the REAL session-provider wiring (bridge, history
// renderer, Anthropic adapter) against a loopback Messages endpoint on the real Opus 5.5 row, and the
// session persists through the REAL on-disk store (`resolveEngineSession`: transcript + sidecar).
//
// The script covers every in-dialect shape a replay has to put back in place: thinking interleaved
// with text and a call (`[thinking, text, thinking, tool_use]`), a `redacted_thinking` block, a
// thinking block whose signature is `""`, a reply with no thinking at all, and a resume in between.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compatibilityKeys, type RuntimeConfig, type WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type EngineOptions } from "../engine.ts";
import { resolveEngineSession } from "../store/dialect.ts";
import { buildSessionProvider, loadResumedChain } from "./session-provider.ts";
import { describeCatalogModel } from "../production-wiring.ts";
import { createSystemPromptAssembler } from "../context/assembler.ts";
import { fakeAnthropicCatalog, startAnthropicFake, type AnthropicFake, type FakeResponse } from "./anthropic-fake.test-support.ts";
import "../tools/impl/index.ts";

const MODEL = "anthropic/claude-opus-5-5";
const GOLDEN_PATH = join(import.meta.dir, "reasoning-blocks-wire.golden.json");
const UPDATE = process.env["WINTER_UPDATE_REASONING_GOLDEN"] === "1";

/** The endpoint's answers, keyed by the user turn the request belongs to and whether a tool result is already in it. */
function answer(body: Record<string, unknown>): FakeResponse {
  const text = JSON.stringify(body["messages"]);
  if (text.includes("turn three")) return { blocks: [{ type: "thinking", thinking: "third thoughts", signature: "sig-c" }, { type: "text", text: "done three" }], stopReason: "end_turn" };
  if (text.includes("turn two")) return { blocks: [{ type: "text", text: "plain two" }], stopReason: "end_turn" };
  if (text.includes("toolu_glob")) {
    return {
      blocks: [
        { type: "redacted_thinking", data: "REDACTED-OPAQUE-1" },
        { type: "thinking", thinking: "wrap up", signature: "" },
        { type: "text", text: "done one" },
      ],
      stopReason: "end_turn",
    };
  }
  return {
    blocks: [
      { type: "thinking", thinking: "look first", signature: "sig-a" },
      { type: "text", text: "Let me check." },
      { type: "thinking", thinking: "then glob", signature: "sig-b" },
      { type: "tool_use", id: "toolu_glob", name: "Glob", input: { pattern: "*.winter-reasoning-none" } },
    ],
    stopReason: "tool_use",
  };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Fixture {
  fake: AnthropicFake;
  home: string;
  cwd: string;
}

async function fixture(): Promise<Fixture> {
  const fake = await startAnthropicFake((request) => answer(request.body));
  const home = mkdtempSync(join(tmpdir(), "winter-reasoning-wire-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "winter-reasoning-wire-cwd-"));
  cleanups.push(async () => {
    await fake.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  return { fake, home, cwd };
}

/** One run of the engine over the real store: `resume` names a session to continue. Returns the frames it wrote. */
async function runSession(fx: Fixture, sessionId: string, turns: string[], resume?: string): Promise<WinterFrame[]> {
  const catalog = fakeAnthropicCatalog(fx.fake.url, [MODEL]);
  const base = {
    sessionId,
    cwd: fx.cwd,
    model: MODEL,
    effort: "high",
    winterHome: fx.home,
    provider: { providerId: "anthropic", authRef: { kind: "inline", value: "fixture" }, connection: { baseUrl: fx.fake.url, local: true } },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    ...(resume !== undefined ? { resume } : {}),
  } as unknown as RuntimeConfig;
  const resolved = await resolveEngineSession({ config: base, resolveWinterHome: () => fx.home, env: {} });
  const chain = await loadResumedChain(resolved.store, resolved.initialMessages);
  const wiring = buildSessionProvider({ config: resolved.config, env: {}, catalog, credentials: createMemoryCredentialStore(), chain: () => chain });
  const identity = wiring.identity!;
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: resolved.config,
    input: runtime.input,
    output: runtime.output,
    provider: wiring.provider,
    providerIdentity: { providerId: identity.providerId, modelKey: identity.modelKey, family: "anthropic", ...(identity.continuationDomain !== undefined ? { continuationDomain: identity.continuationDomain } : {}) },
    describeModel: (model: string, providerId?: string) => describeCatalogModel(catalog, model, providerId),
    // The production request layout: cache blocks on the system prompt, so the rolling message
    // breakpoint is on the wire too, and the index-0 context message ahead of the history.
    systemPromptAssembler: createSystemPromptAssembler({ home: fx.home, settings: () => ({}) }),
    ...(resolved.store !== undefined ? { store: resolved.store } : {}),
    ...(resolved.initialMessages.length > 0 ? { initialMessages: resolved.initialMessages } : {}),
  } as EngineOptions);
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  const results = (): number => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").length;
  for (let i = 0; i < turns.length; i++) {
    host.output.write({ type: "user", text: turns[i]! });
    for (let n = 0; n < 3000 && results() < i + 1; n++) await new Promise((r) => setTimeout(r, 2));
  }
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
  return frames;
}

/** A request's `messages`, with the fixture's temp paths and the index-0 context's date folded to placeholders. */
function normalizedMessages(fx: Fixture, body: Record<string, unknown>): unknown {
  return JSON.parse(normalize(fx, JSON.stringify(body["messages"])));
}

function normalize(fx: Fixture, text: string): string {
  return text.split(fx.cwd).join("<CWD>").split(fx.home).join("<HOME>").replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>");
}

/** The session's transcript and sidecar files under the fixture home, relative paths -> contents. */
function sessionFiles(fx: Fixture, sessionId: string): Record<string, string> {
  const out: Record<string, string> = {};
  const projects = join(fx.home, "projects");
  for (const project of readdirSync(projects)) {
    for (const name of [`${sessionId}.jsonl`, `${sessionId}.provider-state.jsonl`]) {
      const path = join(projects, project, name);
      if (existsSync(path)) out[name] = readFileSync(path, "utf8").split(fx.cwd).join("<CWD>").split(fx.home).join("<HOME>");
    }
  }
  return out;
}

interface Golden {
  /** The uninterrupted session's four requests. */
  live: unknown[];
  /** The request a session resumed after turn two sends for turn three. */
  resumed: unknown;
  /** The pre-move transcript and sidecar the two-turn session left behind (inline thinking), placeholders for the temp paths. */
  preMoveSession: Record<string, string>;
}

function readGolden(): Golden {
  return JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Golden;
}

describe("Anthropic reasoning moves to the sidecar and the wire does not move (WS-23 reasoning-state item 1)", () => {
  test("live, resumed and pre-move-transcript sessions send the golden bytes", async () => {
    const live = await fixture();
    await runSession(live, "reasoning-live", ["turn one", "turn two", "turn three"]);
    expect(live.fake.requests).toHaveLength(4);
    const liveMessages = live.fake.requests.map((r) => normalizedMessages(live, r.body));

    const split = await fixture();
    await runSession(split, "reasoning-split", ["turn one", "turn two"]);
    // Named for the golden's field: on the commit that captured the golden this WAS the pre-move session.
    const preMoveSession = sessionFiles(split, "reasoning-split");
    await runSession(split, "reasoning-split-resumed", ["turn three"], "reasoning-split");
    expect(split.fake.requests).toHaveLength(4);
    const resumedMessages = normalizedMessages(split, split.fake.requests[3]!.body);

    if (UPDATE) {
      // The pre-move session is history: a regeneration on a post-move commit keeps the one already
      // captured rather than replacing it with a neutral transcript.
      const kept = existsSync(GOLDEN_PATH) ? readGolden().preMoveSession : preMoveSession;
      writeFileSync(GOLDEN_PATH, `${JSON.stringify({ live: liveMessages, resumed: resumedMessages, preMoveSession: kept } satisfies Golden, null, 2)}\n`);
      return;
    }
    const golden = readGolden();
    expect(liveMessages).toEqual(golden.live);
    expect(resumedMessages).toEqual(golden.resumed);
    // AND THE MOVE REALLY HAPPENED: the transcript the split session wrote is provider-neutral -- no
    // thinking, no signature, no opaque data -- and the sidecar carries every block, verbatim, with its
    // stream index. (Without this the golden would also pass on the pre-move code.)
    const transcript = preMoveSession["reasoning-split.jsonl"]!;
    for (const needle of ['"thinking"', '"redacted_thinking"', '"signature"', "sig-a", "REDACTED-OPAQUE-1", "look first"]) expect(transcript).not.toContain(needle);
    const sidecar = preMoveSession["reasoning-split.provider-state.jsonl"]!.trim().split("\n").map((line) => JSON.parse(line) as { kind: string; payload: unknown });
    expect(sidecar.filter((r) => r.kind === "reasoning-blocks").map((r) => r.payload)).toEqual([
      {
        blocks: [
          { at: 0, block: { type: "thinking", thinking: "look first", signature: "sig-a" } },
          { at: 2, block: { type: "thinking", thinking: "then glob", signature: "sig-b" } },
        ],
      },
      {
        blocks: [
          { at: 0, block: { type: "redacted_thinking", data: "REDACTED-OPAQUE-1" } },
          { at: 1, block: { type: "thinking", thinking: "wrap up", signature: "" } },
        ],
      },
    ]);
    // A resume re-sends exactly what the uninterrupted session sent: same bytes, same positions.
    expect(JSON.stringify(resumedMessages)).toBe(JSON.stringify(liveMessages[3]));
    // Append-only across the live session, the rolling breakpoint aside.
    const strip = (value: unknown): string => JSON.stringify(JSON.parse(JSON.stringify(value), (key, v) => (key === "cache_control" ? undefined : v)));
    for (let i = 0; i + 1 < liveMessages.length; i++) {
      const next = liveMessages[i + 1] as unknown[];
      const prev = liveMessages[i] as unknown[];
      expect(strip(next.slice(0, prev.length))).toBe(strip(prev));
    }
  });

  test("a transcript written BEFORE the move (thinking inline) resumes to the golden bytes, and is never rewritten", async () => {
    if (UPDATE) return;
    const golden = readGolden();
    const fx = await fixture();
    // Materialise the pre-move session under this fixture's own home and cwd.
    const projectDir = join(fx.home, "projects", compatibilityKeys(fx.cwd).transcriptProjectKey);
    for (const [name, content] of Object.entries(golden.preMoveSession)) {
      const path = join(projectDir, name.replace("reasoning-split", "reasoning-old"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content.split("<CWD>").join(fx.cwd).split("<HOME>").join(fx.home).split("reasoning-split").join("reasoning-old"), { mode: 0o600 });
    }
    const transcriptBefore = readFileSync(join(projectDir, "reasoning-old.jsonl"), "utf8");
    await runSession(fx, "reasoning-old-resumed", ["turn three"], "reasoning-old");
    expect(fx.fake.requests).toHaveLength(1);
    expect(normalizedMessages(fx, fx.fake.requests[0]!.body)).toEqual(golden.resumed);
    // Read in place: the old entries are untouched (new turns only append after them).
    expect(readFileSync(join(projectDir, "reasoning-old.jsonl"), "utf8").startsWith(transcriptBefore)).toBe(true);
  });
});
