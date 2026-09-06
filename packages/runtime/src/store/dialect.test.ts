// Task 8: the Claude-dialect transcript writer/reader (WS-05 §5.2) — userEntry/assistantEntry
// field-shape unit tests, TranscriptWriter's chain-holding + readBack validation, the
// unknown-entry-survives-a-round-trip guarantee, the dialect-record summary sidecar, the
// engineVersion source, and (last) a full temp-WINTER_HOME end-to-end run over the in-memory leg.
//
// Every winterHome below is a fresh mkdtemp under the OS temp dir — never ~/.winter, ~/.norma,
// ~/.claude, or a real shared path. cwd fixtures are synthetic ("/winter-fixture", never
// process.cwd()) so a derived projectKey never embeds a real username. No real usernames appear
// anywhere below.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { encodeFrame, splitFrames } from "@yanlinglabs/winter-agent-sdk";
import type { RuntimeConfig, WinterFrame, SpawnedRuntimeProcess } from "@yanlinglabs/winter-agent-sdk";

import {
  userEntry,
  assistantEntry,
  invokedSkillsEntry,
  fileHistoryEntry,
  INVOKED_SKILLS_ENTRY_TYPE,
  FILE_HISTORY_ENTRY_TYPE_BY_KIND,
  TranscriptWriter,
  RUNTIME_ENGINE_VERSION,
  buildChildTranscriptWriter,
  childTranscriptSubpath,
  listChildAgentIds,
  type Chain,
  type SessionCtx,
} from "./dialect.ts";
// session-store.ts and paths/keys.ts moved to the sdk package (Task 10, WS-05 §6).
import { WinterCompatibilitySessionStore, DIALECT_RECORD_ENTRY_TYPE, type SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import { compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
import { inMemoryProcess } from "../testing.ts";
import { scriptedProvider, stubExecutor } from "../provider/mock.ts";
import type { ToolExecutor } from "../engine.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "winter-dialect-test-"));
}

const CTX: SessionCtx = { sessionId: "11111111-1111-4111-8111-111111111111", cwd: "/winter-fixture", version: "0.0.1" };

describe("userEntry", () => {
  test("produces the full WS-05 §5.2 field set, a null parentUuid at the chain head, and an ISO timestamp", () => {
    const chain: Chain = { parentUuid: null };
    const entry = userEntry({ text: "hi", chain, ctx: CTX });

    expect(entry.type).toBe("user");
    expect(entry.parentUuid).toBeNull();
    expect(typeof entry.uuid).toBe("string");
    expect(entry.uuid.length).toBeGreaterThan(0);
    expect(entry.sessionId).toBe(CTX.sessionId);
    expect(entry.cwd).toBe(CTX.cwd);
    expect(entry.version).toBe(CTX.version);
    expect(entry.isSidechain).toBe(false);
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    expect(entry.message).toEqual({ role: "user", content: "hi" });
  });

  test("links to a non-null chain head via parentUuid", () => {
    const chain: Chain = { parentUuid: "parent-uuid-1" };
    const entry = userEntry({ text: "again", chain, ctx: CTX });
    expect(entry.parentUuid).toBe("parent-uuid-1");
  });

  // Brief's literal opts shape is `{ text: string; ... }`, but the brief's own prose requires tool
  // results to route through userEntry as content BLOCKS ("tool results → userEntry with
  // tool_result blocks") — content blocks are never a `string`. Read as: userEntry accepts EITHER
  // a plain `text` string OR pre-built `content` blocks (both produce the same
  // `string | Block[]`-typed message.content the brief's return signature already declares).
  test("accepts tool_result content blocks directly (the tool-results-via-userEntry shape)", () => {
    const chain: Chain = { parentUuid: "p1" };
    const blocks = [{ type: "tool_result" as const, tool_use_id: "call1", content: "ok" }];
    const entry = userEntry({ content: blocks, chain, ctx: CTX });
    expect(entry.message).toEqual({ role: "user", content: blocks });
  });

  test("each call produces a fresh, unique uuid", () => {
    const chain: Chain = { parentUuid: null };
    const a = userEntry({ text: "a", chain, ctx: CTX });
    const b = userEntry({ text: "b", chain, ctx: CTX });
    expect(a.uuid).not.toBe(b.uuid);
  });
});

describe("assistantEntry", () => {
  test("carries content blocks (text and/or tool_use) and the same base field set", () => {
    const chain: Chain = { parentUuid: "p1" };
    const blocks = [{ type: "tool_use" as const, id: "call1", name: "t", input: { x: 1 } }];
    const entry = assistantEntry({ content: blocks, chain, ctx: CTX });

    expect(entry.type).toBe("assistant");
    expect(entry.parentUuid).toBe("p1");
    expect(entry.sessionId).toBe(CTX.sessionId);
    expect(entry.cwd).toBe(CTX.cwd);
    expect(entry.version).toBe(CTX.version);
    expect(entry.isSidechain).toBe(false);
    expect(entry.message).toEqual({ role: "assistant", content: blocks });
  });
});

describe("TranscriptWriter", () => {
  test("holds the chain head across calls: each entry's parentUuid is the previous entry's uuid", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-a", sessionId: "sess-1" };
      const writer = new TranscriptWriter({ store, key, ctx: { sessionId: "sess-1", cwd: "/winter-fixture", version: "0.0.1" } });

      await writer.recordUserEntry("hi");
      await writer.recordAssistantEntry([{ type: "text", text: "hello" }]);
      await writer.recordUserEntry([{ type: "tool_result", tool_use_id: "c1", content: "ok" }]);

      const entries = await store.load(key);
      expect(entries).not.toBeNull();
      expect(entries!.length).toBe(3);
      expect(entries![0]!.parentUuid).toBeNull();
      expect(entries![1]!.parentUuid).toBe(entries![0]!.uuid);
      expect(entries![2]!.parentUuid).toBe(entries![1]!.uuid);
      for (const e of entries!) expect(e.isSidechain).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("flush() resolves without error (every record call already awaits store.append)", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-a", sessionId: "sess-1" };
      const writer = new TranscriptWriter({ store, key, ctx: { sessionId: "sess-1", cwd: "/winter-fixture", version: "0.0.1" } });
      await writer.recordUserEntry("hi");
      await expect(writer.flush()).resolves.toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("readBack validates a well-formed transcript without throwing", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-a", sessionId: "sess-1" };
      const writer = new TranscriptWriter({ store, key, ctx: { sessionId: "sess-1", cwd: "/winter-fixture", version: "0.0.1" } });
      await writer.recordUserEntry("hi");
      await writer.recordAssistantEntry([{ type: "text", text: "hello" }]);

      const entries = await TranscriptWriter.readBack(store, key);
      expect(entries.length).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("readBack rejects a duplicate uuid", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-a", sessionId: "sess-1" };
      const dupe: SessionStoreEntry = { type: "user", uuid: "dupe-1", parentUuid: null, timestamp: new Date().toISOString() };
      await store.append(key, [dupe, { ...dupe }]);
      await expect(TranscriptWriter.readBack(store, key)).rejects.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("readBack rejects an unreachable parentUuid", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-a", sessionId: "sess-1" };
      const orphan: SessionStoreEntry = { type: "user", uuid: "child-1", parentUuid: "never-existed", timestamp: new Date().toISOString() };
      await store.append(key, [orphan]);
      await expect(TranscriptWriter.readBack(store, key)).rejects.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an unknown entry type with unknown fields survives load -> re-append -> load byte-losslessly (deep-equal)", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-a", sessionId: "sess-1" };
      const writer = new TranscriptWriter({ store, key, ctx: { sessionId: "sess-1", cwd: "/winter-fixture", version: "0.0.1" } });
      await writer.recordUserEntry("hi");

      // An entry shape Winter's own producer never writes (WS-05 §5.1's corpus lists variants this
      // engine can't yet produce, e.g. attachment/system-sub types) but MUST NOT corrupt if it's
      // already present in a transcript being extended (WS-05 §5.2: "preserve every unknown field
      // read, even uninterpreted").
      const injected: SessionStoreEntry = {
        type: "totally-unknown-variant",
        uuid: "unknown-1",
        parentUuid: null,
        someFutureField: { nested: [1, 2, 3] },
        anotherField: "surprise",
      };
      await store.append(key, [injected]);

      const firstLoad = await TranscriptWriter.readBack(store, key);
      const injectedBack = firstLoad.find((e) => e.uuid === "unknown-1");
      expect(injectedBack).toEqual(injected);

      // Re-append everything just read back, to a FRESH key, and confirm it round-trips deep-equal
      // again — this is the "re-appending preserves them deep-equal" half of the brief's test plan.
      const key2 = { projectKey: "proj-a", sessionId: "sess-2" };
      await store.append(key2, firstLoad);
      const secondLoad = await store.load(key2);
      expect(secondLoad).toEqual(firstLoad);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // T8 fix-wave: validateChain's own filter (`typeof e.uuid === "string"`) is exercised only
  // INDIRECTLY by every test above (a well-formed chain has a uuid on every entry) — this pins the
  // SKIP path directly: an entry with no uuid at all (a plain marker, same shape
  // session-store.test.ts's own "no dedup of UUID-less entries" fixture uses) sits ALONGSIDE a real
  // chain and must neither be treated as part of the chain (no duplicate/unreachable-parent
  // complaint) nor be dropped — readBack is a lossless pass-through of every entry it loads.
  test("readBack never chokes on a no-uuid entry interleaved in an otherwise valid chain, and returns it unchanged", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-a", sessionId: "sess-1" };
      const writer = new TranscriptWriter({ store, key, ctx: { sessionId: "sess-1", cwd: "/winter-fixture", version: "0.0.1" } });
      await writer.recordUserEntry("hi");

      const marker: SessionStoreEntry = { type: "mode_marker" }; // deliberately no uuid, no parentUuid
      await store.append(key, [marker]);

      await writer.recordAssistantEntry([{ type: "text", text: "hello" }]);

      const entries = await TranscriptWriter.readBack(store, key);
      expect(entries.length).toBe(3);
      expect(entries[1]).toEqual(marker); // present, unchanged, in its actual append position
      // the two REAL chain entries still validated correctly around it
      expect(entries[2]!.parentUuid).toBe(entries[0]!.uuid);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// Phase 4 Task 3 (MUST 2, WS-05 §4/§5.2/§5.3, WS-10 §7): child (subagent) transcripts in the store.
describe("child (subagent) transcripts", () => {
  test("write/read round-trip: every entry carries isSidechain:true, agentId, and parent_tool_use_id; the main session's own key is untouched", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const child = buildChildTranscriptWriter({
        store,
        projectKey: "proj-a",
        parentSessionId: "parent-1",
        agentId: "agent-abc",
        parentToolUseId: "tooluse-1",
        cwd: "/winter-fixture",
      });
      await child.recordUserEntry("do the thing");
      await child.recordAssistantEntry([{ type: "text", text: "done" }]);

      const childKey = { projectKey: "proj-a", sessionId: "parent-1", subpath: childTranscriptSubpath("agent-abc") };
      const entries = await TranscriptWriter.readBack(store, childKey);
      expect(entries.length).toBe(2);
      for (const e of entries) {
        expect(e.isSidechain).toBe(true);
        expect(e.agentId).toBe("agent-abc");
        expect(e.parent_tool_use_id).toBe("tooluse-1");
        expect(e.sessionId).toBe("parent-1"); // the OWNING parent's session id, not the agentId
      }
      // The child's own chain is independent -- its first entry has no parent.
      expect(entries[0]!.parentUuid).toBeNull();
      expect(entries[1]!.parentUuid).toBe(entries[0]!.uuid);

      // The main session's own key (no subpath) has nothing written to it by the child writer.
      const mainEntries = await store.load({ projectKey: "proj-a", sessionId: "parent-1" });
      expect(mainEntries).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("sidecar separation: the agent_metadata envelope lands ONLY in .meta.json -- the raw *.jsonl file on disk never contains an agent_metadata line", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const child = buildChildTranscriptWriter({
        store,
        projectKey: "proj-a",
        parentSessionId: "parent-1",
        agentId: "agent-meta",
        parentToolUseId: "tooluse-1",
        cwd: "/winter-fixture",
      });
      await child.recordUserEntry("hi");
      await child.writeMetadata({ id: "agent-meta", status: "completed", model: { effectiveModel: "sonnet", effectiveEffort: "medium" } });

      // Read the RAW jsonl straight off disk -- store.load()/TranscriptWriter.readBack both
      // deliberately RE-SYNTHESIZE the metadata as a trailing array entry (session-store.ts's own
      // load()), so asserting against either of those would pass vacuously even if the envelope HAD
      // leaked into the jsonl. This is the one test that can actually tell the two apart.
      const jsonlPath = join(home, "projects", "proj-a", "parent-1", "subagents", "agent-agent-meta.jsonl");
      const rawJsonl = readFileSync(jsonlPath, "utf8");
      expect(rawJsonl).not.toContain("agent_metadata");
      expect(rawJsonl.trim().split("\n").length).toBe(1); // only the one recordUserEntry line

      const metaPath = join(home, "projects", "proj-a", "parent-1", "subagents", "agent-agent-meta.meta.json");
      expect(existsSync(metaPath)).toBe(true);
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
      expect(meta.type).toBe("agent_metadata");
      expect(meta.id).toBe("agent-meta");
      expect(meta.status).toBe("completed");

      // load()'s own documented re-synthesis: the metadata DOES appear, but only as the LAST
      // returned entry, after every native one -- confirms the sidecar is still reachable through
      // the ordinary read path, just never mixed into the model-readable jsonl itself.
      const childKey = { projectKey: "proj-a", sessionId: "parent-1", subpath: childTranscriptSubpath("agent-meta") };
      const loaded = await store.load(childKey);
      expect(loaded).not.toBeNull();
      expect(loaded!.length).toBe(2);
      expect(loaded![1]!.type).toBe("agent_metadata");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a resumed session enumerates its own children via listChildAgentIds, including a metadata-only child that never produced native output", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const sessionKey = { projectKey: "proj-a", sessionId: "parent-1" };

      const childA = buildChildTranscriptWriter({ store, projectKey: "proj-a", parentSessionId: "parent-1", agentId: "a1", parentToolUseId: "t1", cwd: "/winter-fixture" });
      await childA.recordUserEntry("hi");
      const childB = buildChildTranscriptWriter({ store, projectKey: "proj-a", parentSessionId: "parent-1", agentId: "a2", parentToolUseId: "t2", cwd: "/winter-fixture" });
      await childB.recordUserEntry("hi");
      // A third child registered via metadata ONLY (e.g. spawned, not yet produced a turn) -- WS-05
      // §6's own "readable before it has ever produced native output" guarantee.
      const childC = buildChildTranscriptWriter({ store, projectKey: "proj-a", parentSessionId: "parent-1", agentId: "a3", parentToolUseId: "t3", cwd: "/winter-fixture" });
      await childC.writeMetadata({ id: "a3", status: "running" });

      const ids = await listChildAgentIds(store, sessionKey);
      expect([...ids].sort()).toEqual(["a1", "a2", "a3"]);

      // A session with NO children at all reports none, without throwing.
      const emptyIds = await listChildAgentIds(store, { projectKey: "proj-a", sessionId: "childless-session" });
      expect(emptyIds).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("crash/partial-line rules are identical to the main chain: a duplicate uuid in a child transcript is rejected by readBack too", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const childKey = { projectKey: "proj-a", sessionId: "parent-1", subpath: childTranscriptSubpath("agent-dupe") };
      const dupe: SessionStoreEntry = { type: "user", uuid: "dupe-1", parentUuid: null, timestamp: new Date().toISOString(), isSidechain: true, agentId: "agent-dupe" };
      await store.append(childKey, [dupe, { ...dupe }]);
      await expect(TranscriptWriter.readBack(store, childKey)).rejects.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("dialect record sidecar", () => {
  test("every append carries the dialect record into the summary sidecar; it is absent from load()", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-a", sessionId: "sess-1" };
      const writer = new TranscriptWriter({ store, key, ctx: { sessionId: "sess-1", cwd: "/winter-fixture", version: RUNTIME_ENGINE_VERSION } });
      await writer.recordUserEntry("hi");

      const loaded = await store.load(key);
      expect(loaded!.every((e) => e.type !== DIALECT_RECORD_ENTRY_TYPE)).toBe(true);
      for (const e of loaded!) expect(e).not.toHaveProperty("producerRuntime");

      const summaries = await store.listSessionSummaries!("proj-a");
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        producerRuntime: "winter-agent",
        producerEngineVersion: RUNTIME_ENGINE_VERSION,
        dialectFamily: "claude-code-jsonl",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("engineVersion source", () => {
  test("RUNTIME_ENGINE_VERSION matches packages/runtime/package.json's version field", () => {
    const pkgPath = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    expect(RUNTIME_ENGINE_VERSION).toBe(pkg.version);
  });
});

// --- engine wiring end-to-end: a real two-envelope, one-tool-round session over the in-memory leg,
// through a temp WINTER_HOME, asserting the persisted JSONL directly (task-8 brief's Steps). -------

async function drainAll(proc: SpawnedRuntimeProcess): Promise<WinterFrame[]> {
  const frames: WinterFrame[] = [];
  let carry = "";
  for await (const chunk of proc.stdout) {
    const split = splitFrames(chunk, carry);
    carry = split.carry;
    frames.push(...split.frames);
  }
  return frames;
}

describe("engine wiring (temp WINTER_HOME, in-memory leg)", () => {
  test("a two-envelope session with one tool round persists 6 entries: full field set, single-chain parentUuid graph, correct role/content shapes", async () => {
    const home = freshHome();
    try {
      const sessionId = randomUUID();
      const cwd = "/winter-fixture";
      // Ruling P2-I: allowedTools:["t"] pre-approves the tool call so it actually executes — this
      // test is about persistence shape, not permissions.
      const config: RuntimeConfig = { sessionId, cwd, model: "winter-test/echo", allowedTools: ["t"] };
      const provider = scriptedProvider([
        { kind: "tool_use", calls: [{ id: "call1", name: "t", input: {} }] },
        { kind: "text", text: "done" },
        { kind: "text", text: "ok" },
      ]);

      const proc = inMemoryProcess(["--config-json", JSON.stringify(config)], provider, stubExecutor, { WINTER_HOME: home });
      proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
      proc.stdin.write(encodeFrame({ type: "user", text: "thanks" }));
      proc.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));

      await drainAll(proc);
      await proc.exited;

      const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
      const jsonlPath = join(home, "projects", projectKey, `${sessionId}.jsonl`);
      expect(existsSync(jsonlPath)).toBe(true);

      const rawLines = readFileSync(jsonlPath, "utf8").trim().split("\n");
      expect(rawLines).toHaveLength(6);
      expect(rawLines.some((l) => l.includes(DIALECT_RECORD_ENTRY_TYPE))).toBe(false); // never a transcript line
      const rawParsed = rawLines.map((l) => JSON.parse(l) as SessionStoreEntry);

      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const loaded = await store.load({ projectKey, sessionId });
      expect(loaded).toEqual(rawParsed); // load() is a pure pass-through of the raw jsonl here (no meta.json in play)
      expect(loaded!.length).toBe(6);

      // full field set + ISO timestamps on every entry
      for (const e of loaded!) {
        expect(typeof e.uuid).toBe("string");
        expect(e.sessionId).toBe(sessionId);
        expect(e.cwd).toBe(cwd);
        expect(e.version).toBe(RUNTIME_ENGINE_VERSION);
        expect(e.isSidechain).toBe(false);
        expect(typeof e.timestamp).toBe("string");
        expect(new Date(e.timestamp!).toISOString()).toBe(e.timestamp!);
      }

      // single-chain parentUuid graph: entry 0's parent is null, every later entry's parent is its
      // immediate predecessor's uuid
      expect(loaded![0]!.parentUuid).toBeNull();
      for (let i = 1; i < loaded!.length; i++) {
        expect(loaded![i]!.parentUuid).toBe(loaded![i - 1]!.uuid);
      }

      // correct role/content shapes, turn by turn
      expect(loaded![0]!.type).toBe("user");
      expect(loaded![0]!.message).toEqual({ role: "user", content: "go" });
      expect(loaded![1]!.type).toBe("assistant");
      expect((loaded![1]!.message as { content: unknown }).content).toEqual([{ type: "tool_use", id: "call1", name: "t", input: {} }]);
      expect(loaded![2]!.type).toBe("user");
      expect((loaded![2]!.message as { content: unknown }).content).toEqual([{ type: "tool_result", tool_use_id: "call1", content: 't:{}' }]);
      expect(loaded![3]!.type).toBe("assistant");
      expect((loaded![3]!.message as { content: unknown }).content).toEqual([{ type: "text", text: "done" }]);
      expect(loaded![4]!.type).toBe("user");
      expect(loaded![4]!.message).toEqual({ role: "user", content: "thanks" });
      expect(loaded![5]!.type).toBe("assistant");
      expect((loaded![5]!.message as { content: unknown }).content).toEqual([{ type: "text", text: "ok" }]);

      // dialect record sidecar
      const summaries = await store.listSessionSummaries!(projectKey);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        entryCount: 6,
        producerRuntime: "winter-agent",
        producerEngineVersion: RUNTIME_ENGINE_VERSION,
        dialectFamily: "claude-code-jsonl",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("persistSession: false disables persistence entirely — no jsonl is written", async () => {
    const home = freshHome();
    try {
      const sessionId = randomUUID();
      const cwd = "/winter-fixture";
      const config: RuntimeConfig = { sessionId, cwd, model: "winter-test/echo", persistSession: false };
      const proc = inMemoryProcess(["--config-json", JSON.stringify(config)], undefined, undefined, { WINTER_HOME: home });
      proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
      proc.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
      await drainAll(proc);
      await proc.exited;

      const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
      const jsonlPath = join(home, "projects", projectKey, `${sessionId}.jsonl`);
      expect(existsSync(jsonlPath)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Whole-branch review Important 2 (extends the T8 fix-wave item "direct P1-H persisted-transcript
  // test" to ALSO cover P1-G): both rulings pin an ACCUMULATED-HISTORY invariant (engine.test.ts
  // exercises it against the in-memory wire/history), but neither had a test proving the SAME
  // synthetic block actually lands in the PERSISTED jsonl, through the real TranscriptWriter/store
  // stack, over a temp WINTER_HOME — the two are different code paths (engine.ts's `messages` array
  // vs. its `recordUser`/`recordAssistant` calls into dialect.ts), and only the persisted shape is
  // what a later resume ever reads back.
  test("Ruling P1-H: a thrown tool persists a REAL tool_result alongside the error-marked synthetic one — no closing assistant entry", async () => {
    const home = freshHome();
    try {
      const sessionId = randomUUID();
      const cwd = "/winter-fixture";
      // Ruling P2-I: allowedTools pre-approves both calls so they actually execute — this test is
      // about a mid-round throw's persisted shape, not permissions.
      const config: RuntimeConfig = { sessionId, cwd, model: "winter-test/echo", allowedTools: ["good_tool", "bad_tool"] };
      const provider = scriptedProvider([
        { kind: "tool_use", calls: [{ id: "call1", name: "good_tool", input: {} }, { id: "call2", name: "bad_tool", input: {} }] },
      ]);
      const throwingTools: ToolExecutor = {
        async execute(call) {
          if (call.id === "call1") return { output: "ok" };
          throw new Error("tool boom");
        },
      };

      const proc = inMemoryProcess(["--config-json", JSON.stringify(config)], provider, throwingTools, { WINTER_HOME: home });
      proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
      proc.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
      await drainAll(proc);
      await proc.exited;

      const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
      const jsonlPath = join(home, "projects", projectKey, `${sessionId}.jsonl`);
      const rawLines = readFileSync(jsonlPath, "utf8").trim().split("\n");
      const parsed = rawLines.map((l) => JSON.parse(l) as SessionStoreEntry);

      // A thrown round breaks the loop immediately (finalResult is already set) — generate() is
      // never called a second time, so there is no closing assistant entry, same shape as P1-G below.
      expect(parsed.map((e) => e.type)).toEqual(["user", "assistant", "user"]);
      expect(parsed[0]!.message).toEqual({ role: "user", content: "go" });
      expect((parsed[1]!.message as { content: unknown }).content).toEqual([
        { type: "tool_use", id: "call1", name: "good_tool", input: {} },
        { type: "tool_use", id: "call2", name: "bad_tool", input: {} },
      ]);
      expect((parsed[2]!.message as { content: unknown }).content).toEqual([
        { type: "tool_result", tool_use_id: "call1", content: "ok" },
        { type: "tool_result", tool_use_id: "call2", content: "[error: tool boom]", error: true },
      ]);

      // round-trips cleanly through the store's own reader too (validateChain never chokes on it —
      // the tool_use/tool_result pairing invariant genuinely holds on disk, not just in memory)
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      expect(await store.load({ projectKey, sessionId })).toEqual(parsed);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Ruling P1-G: an interrupted round persists assistant(tool_use) + user(tool_result interrupted:true) — no closing assistant entry", async () => {
    const home = freshHome();
    try {
      const sessionId = randomUUID();
      const cwd = "/winter-fixture";
      // Ruling P2-I: allowedTools:["slow_tool"] pre-approves so execution genuinely starts — this
      // test is about an interrupted round's persisted shape, not permissions.
      const config: RuntimeConfig = { sessionId, cwd, model: "winter-test/echo", allowedTools: ["slow_tool"] };

      let enteredExecute!: () => void;
      const entered = new Promise<void>((resolve) => {
        enteredExecute = resolve;
      });
      const blockingTools: ToolExecutor = {
        execute() {
          enteredExecute();
          return new Promise(() => {}); // never resolves — abandoned on interrupt
        },
      };
      const provider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "call1", name: "slow_tool", input: {} }] }]);

      const proc = inMemoryProcess(["--config-json", JSON.stringify(config)], provider, blockingTools, { WINTER_HOME: home });
      proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
      await entered; // deterministic: only interrupt once we KNOW the engine is blocked inside tools.execute()
      proc.stdin.write(encodeFrame({ type: "control_request", requestId: "int1", subtype: "interrupt", payload: undefined }));
      proc.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
      await drainAll(proc);
      await proc.exited;

      const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
      const jsonlPath = join(home, "projects", projectKey, `${sessionId}.jsonl`);
      const rawLines = readFileSync(jsonlPath, "utf8").trim().split("\n");
      const parsed = rawLines.map((l) => JSON.parse(l) as SessionStoreEntry);

      expect(parsed.map((e) => e.type)).toEqual(["user", "assistant", "user"]); // no closing assistant entry
      expect(parsed[0]!.message).toEqual({ role: "user", content: "go" });
      expect((parsed[1]!.message as { content: unknown }).content).toEqual([{ type: "tool_use", id: "call1", name: "slow_tool", input: {} }]);
      expect((parsed[2]!.message as { content: unknown }).content).toEqual([
        { type: "tool_result", tool_use_id: "call1", content: "[interrupted]", interrupted: true },
      ]);

      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      expect(await store.load({ projectKey, sessionId })).toEqual(parsed);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // T8 fix-wave carry: proves persistSession's on/off switch is a pure side channel — the WIRE
  // output a consumer actually sees must never depend on whether a store happens to be recording it.
  // Compares the raw, still-encoded stdout byte stream across three runs (not just the decoded
  // frame arrays — a byte-for-byte diff is the stronger, more literal reading of "wire byte-diff
  // test", and would also catch a hypothetical divergence in framing/encoding, not just payload
  // shape).
  test("persistSession true vs explicit false vs default: the raw WIRE bytes are IDENTICAL across all three — persistence is a pure side channel", async () => {
    const sessionId = randomUUID();
    const cwd = "/winter-fixture";

    async function traceRawStdout(persistSession?: boolean): Promise<string> {
      const home = freshHome();
      try {
        // Ruling P2-I/Task 8: allowedTools:["t"] pre-approves the tool call so it executes (and this
        // wire-equivalence assertion has something real to compare) instead of parking on a real
        // "permission" control_request nobody in this raw-stdout test ever answers.
        const config: RuntimeConfig = { sessionId, cwd, model: "winter-test/echo", allowedTools: ["t"], ...(persistSession !== undefined ? { persistSession } : {}) };
        const provider = scriptedProvider([
          { kind: "tool_use", calls: [{ id: "call1", name: "t", input: {} }] },
          { kind: "text", text: "done" },
        ]);
        const proc = inMemoryProcess(["--config-json", JSON.stringify(config)], provider, stubExecutor, { WINTER_HOME: home });
        proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
        proc.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
        let raw = "";
        for await (const chunk of proc.stdout) raw += chunk;
        await proc.exited;
        return raw;
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }

    const defaultBytes = await traceRawStdout(undefined);
    const explicitTrueBytes = await traceRawStdout(true);
    const explicitFalseBytes = await traceRawStdout(false);

    expect(explicitTrueBytes).toBe(defaultBytes);
    expect(explicitFalseBytes).toBe(defaultBytes);
  });
});


// ------------------------------------------------------------------------------------------------
// Phase 5 fix wave, B-M1: the two entry types rider 16 added shipped with NO tests of their own.
// The writer methods were exercised only indirectly, and the entries not at all.
// ------------------------------------------------------------------------------------------------
describe("B-M1: the rider-16 entry types", () => {
  test("`invokedSkillsEntry` carries the base fields, the payload, and a COPY of the array", () => {
    const skills = [{ name: "review", source: "project" }];
    const entry = invokedSkillsEntry({ attachment: { type: "invoked_skills", skills }, chain: { parentUuid: null }, ctx: CTX });
    expect(entry.type).toBe(INVOKED_SKILLS_ENTRY_TYPE);
    expect(entry.type).toBe("invoked_skills");
    expect(entry.skills).toEqual(skills);
    expect(entry.parentUuid).toBeNull();
    expect(entry.sessionId).toBe(CTX.sessionId);
    expect(entry.cwd).toBe(CTX.cwd);
    expect(typeof entry.uuid).toBe("string");
    expect(typeof entry.timestamp).toBe("string");
    // The copy is the load-bearing part: a transcript entry must not change under a reader because
    // the caller went on mutating the payload it handed in.
    skills.push({ name: "sneaked-in-later", source: "project" });
    expect(entry.skills).toHaveLength(1);
  });

  test("`fileHistoryEntry` picks its type from the record's KIND and never reshapes the record", () => {
    const base = {
      userMessageUuid: "u-1",
      path: "/winter-fixture/src/a.ts",
      pathHash: "hash-a",
      tool: "Edit",
      at: "2026-09-05T00:00:00.000Z",
      version: 2,
      absent: false,
      parentRealPath: "/winter-fixture/src",
    } as const;
    const snap = fileHistoryEntry({ record: { ...base, kind: "snapshot" }, chain: { parentUuid: null }, ctx: CTX });
    const delta = fileHistoryEntry({ record: { ...base, kind: "delta" }, chain: { parentUuid: null }, ctx: CTX });
    expect(snap.type).toBe(FILE_HISTORY_ENTRY_TYPE_BY_KIND.snapshot);
    expect(delta.type).toBe(FILE_HISTORY_ENTRY_TYPE_BY_KIND.delta);
    expect(snap.type).toBe("file-history-snapshot");
    expect(delta.type).toBe("file-history-delta");
    // NESTED under `file_history`, not spread across the entry -- which is the shape a reader has to
    // know and the one nothing asserted. Every field of Lane K's CheckpointRecord survives verbatim:
    // this module is a carrier, and a silently-dropped optional (`parentRealPath`, `absent`) is the
    // failure mode worth pinning.
    expect(snap.file_history).toEqual({ ...base, kind: "snapshot" });
    expect(delta.file_history).toEqual({ ...base, kind: "delta" });
    expect((snap as unknown as Record<string, unknown>)["path"]).toBeUndefined();
  });

  test("both entries hold the chain and round-trip through the store like any other entry", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-bm1", sessionId: "sess-bm1" };
      const writer = new TranscriptWriter({ store, key, ctx: { sessionId: "sess-bm1", cwd: "/winter-fixture", version: "0.0.1" } });

      await writer.recordUserEntry("hi");
      await writer.recordInvokedSkills({ type: "invoked_skills", skills: [{ name: "review" }] });
      await writer.recordFileHistory({
        kind: "snapshot",
        userMessageUuid: "u-1",
        path: "/winter-fixture/src/a.ts",
        pathHash: "hash-a",
        tool: "Write",
        at: "2026-09-05T00:00:00.000Z",
        version: 1,
      });
      await writer.recordAssistantEntry([{ type: "text", text: "done" }]);

      const entries = await store.load(key);
      expect(entries!.map((e) => e.type)).toEqual(["user", "invoked_skills", "file-history-snapshot", "assistant"]);
      // The chain runs THROUGH them: they are entries in the session's own history, not a sidecar.
      for (let i = 1; i < entries!.length; i++) expect(entries![i]!.parentUuid).toBe(entries![i - 1]!.uuid);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("neither entry is CONVERSATIONAL -- a compaction does not preserve or replay them", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-bm1-conv", sessionId: "sess-bm1-conv" };
      const writer = new TranscriptWriter({ store, key, ctx: { sessionId: "sess-bm1-conv", cwd: "/winter-fixture", version: "0.0.1" } });

      await writer.recordUserEntry("first");
      await writer.recordInvokedSkills({ type: "invoked_skills", skills: [] });
      await writer.recordFileHistory({ kind: "delta", userMessageUuid: "u-1", path: "/winter-fixture/a", pathHash: "h", tool: "Edit", at: "2026-09-05T00:00:00.000Z", version: 1 });
      await writer.recordAssistantEntry([{ type: "text", text: "reply" }]);

      // `recordCompactBoundary` rebuilds its retained set from the writer's tracked CONVERSATIONAL
      // uuids. This is the claim the rider-16 header makes in prose -- "nothing reads the transcript
      // entry for behaviour" -- and it had no test: if either method had called `trackConversational`,
      // a checkpoint record would be handed to a provider as conversation.
      //
      // `retainedCount: 4` DELIBERATELY EXCEEDS the two conversational entries. That is what makes
      // the negative assertions mean anything: an under-sized count would preserve two entries that
      // happen to be the user and assistant ones and prove nothing about the other two. Asking for
      // MORE than exist forces the writer to hand back everything it considers conversational --
      // so if either new entry were tracked, it would appear here.
      const result = await writer.recordCompactBoundary({ trigger: "manual", preTokens: 100, summary: "SUMMARY", retainedCount: 4 });
      const entries = await store.load(key);
      const byUuid = new Map(entries!.map((e) => [e.uuid, e]));
      const preservedTypes = result.preservedUuids.map((u) => byUuid.get(u)?.type);
      // Guard against the vacuous pass: an empty set satisfies every `not.toContain` below.
      expect(preservedTypes).toHaveLength(2);
      expect(preservedTypes).not.toContain("invoked_skills");
      expect(preservedTypes).not.toContain("file-history-delta");
      expect(new Set(preservedTypes)).toEqual(new Set(["user", "assistant"]));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
