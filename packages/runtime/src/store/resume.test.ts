// Task 9 (WS-05 §7): continue/resume/fork/resume-at.
//
// This file covers the four pure/store-level primitives in resume.ts directly (findContinueTarget,
// findResumeTarget, forkSession, truncateAt), the P1-N record/apply mechanics (resolveEngineSession
// persists+prefers the resolved WINTER_PROJECT_DIR_NAME), and end-to-end engine wiring (resume
// message-rebuild fidelity, forkSession-on-resume, resumeSessionAt, pre-allocated sessionId,
// persistSession:false). The cross-process/cross-leg equivalence scenario lives in
// packages/sdk/src/transport-equivalence.test.ts (extends registerEquivalenceScenarios).
//
// Every winterHome below is a fresh mkdtemp under the OS temp dir — never ~/.winter, ~/.norma,
// ~/.claude, or a real shared path. cwd fixtures are synthetic ("/winter-fixture") so a derived
// projectKey never embeds a real username. No real usernames appear anywhere below.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { encodeFrame, splitFrames } from "@yanlinglabs/winter-agent-sdk";
import type { RuntimeConfig, WinterFrame, SpawnedRuntimeProcess } from "@yanlinglabs/winter-agent-sdk";

import {
  findContinueTarget,
  findResumeTarget,
  forkSession,
  truncateAt,
  ResumeTargetError,
  ResumeTruncationError,
  type DialectEntry,
} from "./resume.ts";
import { WinterCompatibilitySessionStore, type SessionStoreEntry } from "./session-store.ts";
import { compatibilityKeys } from "../paths/keys.ts";
import { inMemoryProcess } from "../testing.ts";
import { scriptedProvider, stubExecutor } from "../provider/mock.ts";
import type { Provider, ProviderMessage, ToolExecutor } from "../engine.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "winter-resume-test-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let seq = 0;
function rawEntry(overrides: Partial<SessionStoreEntry> = {}): SessionStoreEntry {
  seq += 1;
  return { type: "user", uuid: `uuid-${seq}`, parentUuid: null, timestamp: new Date().toISOString(), ...overrides };
}

// --- findContinueTarget ---------------------------------------------------------------------------

describe("findContinueTarget", () => {
  test("returns null when the project has no sessions", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      expect(await findContinueTarget(store, "empty-project")).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("returns the newest session's id by mtime — never by append order or lexical order", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      // "zzz-old" is lexically LAST and appended FIRST — if findContinueTarget picked by either of
      // those signals instead of real mtime, this would return the wrong id.
      await store.append({ projectKey: "proj", sessionId: "zzz-old" }, [rawEntry()]);
      await sleep(10); // the established mtime-ordering pattern (session-store.test.ts)
      await store.append({ projectKey: "proj", sessionId: "aaa-new" }, [rawEntry()]);

      expect(await findContinueTarget(store, "proj")).toBe("aaa-new");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// --- findResumeTarget ------------------------------------------------------------------------------

describe("findResumeTarget", () => {
  test("resolves to the current project outright when the session exists there — even if a same-id session ALSO exists in a foreign project", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      await store.append({ projectKey: "current", sessionId: "shared-id" }, [rawEntry()]);
      await store.append({ projectKey: "foreign", sessionId: "shared-id" }, [rawEntry()]);

      const found = await findResumeTarget(store, { sessionId: "shared-id", cwdKey: "current" });
      expect(found).toEqual({ projectKey: "current" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("falls back to searching every other project and finds the unique foreign match", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      await store.append({ projectKey: "elsewhere", sessionId: "target-id" }, [rawEntry()]);

      const found = await findResumeTarget(store, { sessionId: "target-id", cwdKey: "current" });
      expect(found).toEqual({ projectKey: "elsewhere" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("throws a typed not-found error when the session exists nowhere", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      await store.append({ projectKey: "current", sessionId: "other-id" }, [rawEntry()]);

      let thrown: unknown;
      try {
        await findResumeTarget(store, { sessionId: "does-not-exist", cwdKey: "current" });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ResumeTargetError);
      expect((thrown as ResumeTargetError).reason).toBe("not_found");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("throws a typed ambiguous error when the session exists in more than one foreign project — never picks arbitrarily", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      await store.append({ projectKey: "foreign-a", sessionId: "dup-id" }, [rawEntry()]);
      await store.append({ projectKey: "foreign-b", sessionId: "dup-id" }, [rawEntry()]);

      let thrown: unknown;
      try {
        await findResumeTarget(store, { sessionId: "dup-id", cwdKey: "current" });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ResumeTargetError);
      expect((thrown as ResumeTargetError).reason).toBe("ambiguous");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// --- forkSession -------------------------------------------------------------------------------

const RFC4122_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("forkSession", () => {
  test("copies entries into a new session under a fresh lowercase RFC4122 v4 uuid, rewriting each entry's sessionId", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const src = { projectKey: "proj", sessionId: "src-session" };
      await store.append(src, [
        { type: "user", uuid: "u1", parentUuid: null, sessionId: "src-session", message: { role: "user", content: "hi" } },
        { type: "assistant", uuid: "u2", parentUuid: "u1", sessionId: "src-session", message: { role: "assistant", content: "hello" } },
      ]);

      const { sessionId: forkedId } = await forkSession(store, src);
      expect(RFC4122_V4.test(forkedId)).toBe(true);
      expect(forkedId).not.toBe("src-session");

      const forkedEntries = await store.load({ projectKey: "proj", sessionId: forkedId });
      expect(forkedEntries).not.toBeNull();
      expect(forkedEntries!.length).toBe(2);
      for (const e of forkedEntries!) expect(e.sessionId).toBe(forkedId);
      // uuid/parentUuid/content are preserved verbatim — only sessionId is rewritten.
      expect(forkedEntries![0]!.uuid).toBe("u1");
      expect(forkedEntries![1]!.parentUuid).toBe("u1");
      expect(forkedEntries![0]!.message).toEqual({ role: "user", content: "hi" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("leaves the source transcript byte-identical on disk", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const src = { projectKey: "proj", sessionId: "src-session" };
      await store.append(src, [
        { type: "user", uuid: "u1", parentUuid: null, sessionId: "src-session", message: { role: "user", content: "hi" } },
      ]);
      const srcPath = join(home, "projects", "proj", "src-session.jsonl");
      const before = readFileSync(srcPath);

      await forkSession(store, src);

      const after = readFileSync(srcPath);
      expect(after.equals(before)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("throws a typed not-found error when the source session doesn't exist", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      let thrown: unknown;
      try {
        await forkSession(store, { projectKey: "proj", sessionId: "never-existed" });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ResumeTargetError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// --- truncateAt ----------------------------------------------------------------------------------

function de(uuid: string, parentUuid: string | null, type = "user"): DialectEntry {
  return { type, uuid, parentUuid, message: { role: type, content: `content-${uuid}` } };
}

describe("truncateAt", () => {
  test("keeps entries through atUuid and drops the rest when dropsTurn is true and every dropped entry descends from atUuid", () => {
    const entries = [de("a", null), de("b", "a"), de("c", "b"), de("d", "c")];
    const result = truncateAt(entries, { atUuid: "b", dropsTurn: true });
    expect(result.map((e) => e.uuid)).toEqual(["a", "b"]);
  });

  test("is a no-op-safe pass-through when atUuid is already the last entry, regardless of dropsTurn", () => {
    const entries = [de("a", null), de("b", "a")];
    expect(truncateAt(entries, { atUuid: "b", dropsTurn: false }).map((e) => e.uuid)).toEqual(["a", "b"]);
    expect(truncateAt(entries, { atUuid: "b", dropsTurn: true }).map((e) => e.uuid)).toEqual(["a", "b"]);
  });

  test("throws a typed error when atUuid is not found in the entries", () => {
    const entries = [de("a", null), de("b", "a")];
    expect(() => truncateAt(entries, { atUuid: "nonexistent", dropsTurn: true })).toThrow(ResumeTruncationError);
  });

  test("throws a typed error when there are entries to drop but dropsTurn is false", () => {
    const entries = [de("a", null), de("b", "a"), de("c", "b")];
    expect(() => truncateAt(entries, { atUuid: "a", dropsTurn: false })).toThrow(ResumeTruncationError);
  });

  test("throws a typed error when dropsTurn is true but a dropped entry does not descend from atUuid (a divergent branch)", () => {
    // b and c both descend from a; d is a SEPARATE branch off a (NOT a descendant of b) that
    // happens to sit after c in array/file order — truncating "through b" must not silently
    // discard d, since d isn't part of the turn being trimmed.
    const entries = [de("a", null), de("b", "a"), de("c", "b"), de("d", "a")];
    expect(() => truncateAt(entries, { atUuid: "b", dropsTurn: true })).toThrow(ResumeTruncationError);
  });
});

// --- P1-N: recorded project dir name (record + apply) --------------------------------------------

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

function runOneEnvelope(
  config: RuntimeConfig,
  home: string,
  env: Record<string, string | undefined>,
  provider?: Provider,
  tools?: ToolExecutor,
): Promise<{ proc: SpawnedRuntimeProcess; frames: WinterFrame[] }> {
  return (async () => {
    const proc = inMemoryProcess(["--config-json", JSON.stringify(config)], provider, tools, { WINTER_HOME: home, ...env });
    proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
    proc.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
    const frames = await drainAll(proc);
    await proc.exited;
    return { proc, frames };
  })();
}

describe("P1-N: recorded project dir name (record + apply half)", () => {
  test("a session created under a WINTER_PROJECT_DIR_NAME override persists under that name and records it in the summary sidecar", async () => {
    const home = freshHome();
    try {
      const sessionId = randomUUID();
      const cwd = "/winter-fixture";
      const config: RuntimeConfig = { sessionId, cwd, model: "sonnet" };
      await runOneEnvelope(config, home, { WINTER_PROJECT_DIR_NAME: "custom-name" });

      const jsonlPath = join(home, "projects", "custom-name", `${sessionId}.jsonl`);
      expect(existsSync(jsonlPath)).toBe(true);

      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const summaries = await store.listSessionSummaries!("custom-name");
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ projectDirName: "custom-name" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("resuming by explicit id continues writing under the RECORDED name even when the override has since changed/unset", async () => {
    const home = freshHome();
    try {
      const sessionId = randomUUID();
      const cwd = "/winter-fixture";
      const createConfig: RuntimeConfig = { sessionId, cwd, model: "sonnet" };
      await runOneEnvelope(createConfig, home, { WINTER_PROJECT_DIR_NAME: "custom-name" });

      // Resume in a NEW process/instance with the override UNSET this time.
      const resumeConfig: RuntimeConfig = { sessionId: randomUUID(), cwd, model: "sonnet", resume: sessionId };
      await runOneEnvelope(resumeConfig, home, { WINTER_PROJECT_DIR_NAME: undefined });

      // Continued writes land in the ORIGINAL custom-name directory, never a fresh plain-default one.
      const jsonlPath = join(home, "projects", "custom-name", `${sessionId}.jsonl`);
      const loaded = await new WinterCompatibilitySessionStore({ winterHome: home }).load({ projectKey: "custom-name", sessionId });
      expect(existsSync(jsonlPath)).toBe(true);
      expect(loaded!.length).toBe(4); // 2 entries per envelope (user + assistant) x 2 runs

      const defaultProjectKey = compatibilityKeys(cwd).transcriptProjectKey;
      const wrongPath = join(home, "projects", defaultProjectKey, `${sessionId}.jsonl`);
      expect(existsSync(wrongPath)).toBe(false);

      const summaries = await new WinterCompatibilitySessionStore({ winterHome: home }).listSessionSummaries!("custom-name");
      expect(summaries[0]).toMatchObject({ projectDirName: "custom-name", entryCount: 4 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// --- resume wiring end-to-end (temp WINTER_HOME, in-memory leg) -----------------------------------

describe("resume wiring end-to-end (temp WINTER_HOME, in-memory leg)", () => {
  test("continue: true resumes the newest session in the current directory and continues the uuid chain", async () => {
    const home = freshHome();
    try {
      const cwd = "/winter-fixture";
      const firstId = randomUUID();
      await runOneEnvelope({ sessionId: firstId, cwd, model: "sonnet" }, home, {});

      const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const beforeResume = await store.load({ projectKey, sessionId: firstId });
      const lastUuidBeforeResume = beforeResume![beforeResume!.length - 1]!.uuid;

      // continue: true — sessionId here is a throwaway; the engine overrides it with the resolved target.
      await runOneEnvelope({ sessionId: randomUUID(), cwd, model: "sonnet", continue: true }, home, {});

      const after = await store.load({ projectKey, sessionId: firstId });
      expect(after!.length).toBe(4); // 2 envelopes x (user + assistant)
      expect(after![2]!.parentUuid).toBe(lastUuidBeforeResume);
      // full-chain continuity from the very first entry to the very last
      expect(after![0]!.parentUuid).toBeNull();
      for (let i = 1; i < after!.length; i++) expect(after![i]!.parentUuid).toBe(after![i - 1]!.uuid);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("resume rebuilds provider messages EXACTLY as a continuous run would, including a P1-H synthetic error tool_result", async () => {
    const home = freshHome();
    try {
      const cwd = "/winter-fixture";

      // --- continuous run: both envelopes in ONE process/instance ---------------------------------
      const continuousCalls: ProviderMessage[][] = [];
      const continuousProvider: Provider = {
        async generate({ messages }) {
          continuousCalls.push([...messages]);
          if (continuousCalls.length === 1) {
            return { kind: "tool_use", calls: [{ id: "call1", name: "good", input: {} }, { id: "call2", name: "bad", input: {} }] };
          }
          return { kind: "text", text: "done" };
        },
      };
      const throwingTools: ToolExecutor = {
        async execute(call) {
          if (call.id === "call1") return { output: "ok" };
          throw new Error("tool boom");
        },
      };
      const continuousHome = freshHome();
      try {
        const continuousConfig: RuntimeConfig = { sessionId: randomUUID(), cwd, model: "sonnet" };
        const proc = inMemoryProcess(["--config-json", JSON.stringify(continuousConfig)], continuousProvider, throwingTools, {
          WINTER_HOME: continuousHome,
        });
        proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
        proc.stdin.write(encodeFrame({ type: "user", text: "again" }));
        proc.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
        await drainAll(proc);
        await proc.exited;
      } finally {
        rmSync(continuousHome, { recursive: true, force: true });
      }
      expect(continuousCalls.length).toBe(2);

      // --- split run: envelope 1 in run A, envelope 2 resumed in a NEW instance (run B) -----------
      const sessionId = randomUUID();
      await runOneEnvelopeCustom(
        { sessionId, cwd, model: "sonnet" },
        home,
        {},
        scriptedProvider([{ kind: "tool_use", calls: [{ id: "call1", name: "good", input: {} }, { id: "call2", name: "bad", input: {} }] }]),
        throwingTools,
        "go",
      );

      const splitCalls: ProviderMessage[][] = [];
      const splitProvider: Provider = {
        async generate({ messages }) {
          splitCalls.push([...messages]);
          return { kind: "text", text: "done" };
        },
      };
      await runOneEnvelopeCustom({ sessionId: randomUUID(), cwd, model: "sonnet", resume: sessionId }, home, {}, splitProvider, stubExecutor, "again");

      expect(splitCalls.length).toBe(1);
      expect(splitCalls[0]).toEqual(continuousCalls[1]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("forkSession on resume creates a NEW session first, then resumes into it — the original is untouched", async () => {
    const home = freshHome();
    try {
      const cwd = "/winter-fixture";
      const originalId = randomUUID();
      await runOneEnvelope({ sessionId: originalId, cwd, model: "sonnet" }, home, {});

      const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const originalPath = join(home, "projects", projectKey, `${originalId}.jsonl`);
      const originalBytesBefore = readFileSync(originalPath);

      const { frames } = await runOneEnvelope({ sessionId: randomUUID(), cwd, model: "sonnet", resume: originalId, forkSession: true }, home, {});
      const initFrame = frames.find((f) => f.type === "init") as { sessionId: string } | undefined;
      expect(initFrame).toBeDefined();
      const forkedId = initFrame!.sessionId;
      expect(forkedId).not.toBe(originalId);

      // original untouched
      expect(readFileSync(originalPath).equals(originalBytesBefore)).toBe(true);
      const originalEntries = await store.load({ projectKey, sessionId: originalId });
      expect(originalEntries!.length).toBe(2); // unchanged: just its own first envelope

      // the fork has the copied history PLUS the new turn appended after it
      const forkedEntries = await store.load({ projectKey, sessionId: forkedId });
      expect(forkedEntries!.length).toBe(4);
      expect(forkedEntries![2]!.parentUuid).toBe(forkedEntries![1]!.uuid);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("resumeSessionAt truncates the rebuilt history and continues the chain from that uuid, leaving the original tail on disk", async () => {
    const home = freshHome();
    try {
      const cwd = "/winter-fixture";
      const sessionId = randomUUID();
      const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
      const store = new WinterCompatibilitySessionStore({ winterHome: home });

      // Two envelopes so there's real content to truncate away.
      await (async () => {
        const proc = inMemoryProcess(["--config-json", JSON.stringify({ sessionId, cwd, model: "sonnet" })], undefined, undefined, { WINTER_HOME: home });
        proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
        proc.stdin.write(encodeFrame({ type: "user", text: "again" }));
        proc.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
        await drainAll(proc);
        await proc.exited;
      })();

      const before = await store.load({ projectKey, sessionId });
      expect(before!.length).toBe(4);
      const atUuid = before![0]!.uuid!; // truncate back to right after the FIRST user entry — always set by this engine's own producer

      await runOneEnvelope(
        { sessionId: randomUUID(), cwd, model: "sonnet", resume: sessionId, resumeSessionAt: atUuid, resumeDropsTurn: true },
        home,
        {},
      );

      const after = await store.load({ projectKey, sessionId });
      // original tail (entries 1..3) is still ON DISK — resumeSessionAt never deletes; the graph
      // just grows a new branch off atUuid.
      expect(after!.length).toBe(6);
      const newBranchEntries = after!.filter((e) => e.parentUuid === atUuid);
      expect(newBranchEntries.length).toBe(2); // the original next entry AND the new branch's first entry
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a pre-allocated sessionId round-trips into the init frame's sessionId AND the transcript filename", async () => {
    const home = freshHome();
    try {
      const explicitId = "44444444-4444-4444-8444-444444444444";
      const cwd = "/winter-fixture";
      const { frames } = await runOneEnvelope({ sessionId: explicitId, cwd, model: "sonnet" }, home, {});

      const initFrame = frames.find((f) => f.type === "init") as { sessionId: string } | undefined;
      expect(initFrame?.sessionId).toBe(explicitId);

      const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
      expect(existsSync(join(home, "projects", projectKey, `${explicitId}.jsonl`))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("persistSession:false with resume/continue set is a silent fresh, non-persisted run — no throw, no store touched", async () => {
    const home = freshHome();
    try {
      const cwd = "/winter-fixture";
      const sessionId = randomUUID();
      const { frames } = await runOneEnvelope(
        { sessionId, cwd, model: "sonnet", persistSession: false, resume: randomUUID(), continue: true },
        home,
        {},
      );
      expect(frames.some((f) => f.type === "init")).toBe(true); // ran fine, no throw
      const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
      expect(existsSync(join(home, "projects", projectKey))).toBe(false); // nothing ever persisted
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// Variant of runOneEnvelope that takes a custom provider/tools and prompt text (used by the
// message-rebuild-fidelity test above, which needs to script exact provider behavior per run).
function runOneEnvelopeCustom(
  config: RuntimeConfig,
  home: string,
  env: Record<string, string | undefined>,
  provider: Provider,
  tools: ToolExecutor,
  text: string,
): Promise<{ proc: SpawnedRuntimeProcess; frames: WinterFrame[] }> {
  return (async () => {
    const proc = inMemoryProcess(["--config-json", JSON.stringify(config)], provider, tools, { WINTER_HOME: home, ...env });
    proc.stdin.write(encodeFrame({ type: "user", text }));
    proc.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
    const frames = await drainAll(proc);
    await proc.exited;
    return { proc, frames };
  })();
}
