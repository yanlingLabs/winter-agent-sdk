// Task 9 (WS-05 §7): continue/resume/fork/resume-at.
//
// This file covers the three pure/store-level primitives still in resume.ts directly
// (findContinueTarget, findResumeTarget, truncateAt), the P1-N record/apply mechanics
// (resolveEngineSession persists+prefers the resolved WINTER_PROJECT_DIR_NAME), and end-to-end
// engine wiring (resume message-rebuild fidelity, forkSession-on-resume, resumeSessionAt,
// pre-allocated sessionId, persistSession:false). The cross-process/cross-leg equivalence scenario
// lives in packages/sdk/src/transport-equivalence.test.ts (extends registerEquivalenceScenarios).
// Task 10: the fourth primitive, forkSession, relocated to the sdk package alongside the store
// (packages/sdk/src/store/fork-session.ts) -- its own unit tests moved to
// packages/sdk/src/store/fork-session.test.ts; the "forkSession on resume" end-to-end test below
// stays here since it's exercising resolveEngineSession's orchestration, not the primitive itself.
//
// Every winterHome below is a fresh mkdtemp under the OS temp dir — never ~/.winter, ~/.norma,
// ~/.claude, or a real shared path. cwd fixtures are synthetic ("/winter-fixture") so a derived
// projectKey never embeds a real username. No real usernames appear anywhere below.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { encodeFrame, splitFrames } from "@yanlinglabs/winter-agent-sdk";
import type { RuntimeConfig, WinterFrame, SpawnedRuntimeProcess } from "@yanlinglabs/winter-agent-sdk";

import {
  findContinueTarget,
  findResumeTarget,
  truncateAt,
  rebuildProviderMessages,
  ResumeTargetError,
  ResumeTruncationError,
  type DialectEntry,
} from "./resume.ts";
import { resolveEngineSession } from "./dialect.ts";
import type { HookAuditRecord } from "../hooks/runner.ts";
// session-store.ts and paths/keys.ts moved to the sdk package (Task 10, WS-05 §6); forkSession's
// own low-level primitive relocated with the store too (packages/sdk/src/store/fork-session.ts) --
// its unit tests moved alongside it into packages/sdk/src/store/fork-session.test.ts, so this file
// no longer imports or exercises it directly (its own "forkSession on resume" end-to-end test
// below only configures RuntimeConfig.forkSession, a same-named but unrelated boolean option).
import { WinterCompatibilitySessionStore, type SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import type { PermissionUpdate } from "@yanlinglabs/winter-agent-sdk";
import { compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
import { inMemoryProcess } from "../testing.ts";
import { scriptedProvider, stubExecutor, echoProvider } from "../provider/mock.ts";
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

  // Fix-round 1, Ruling P1-R: this test's ORIGINAL name/assertion ("throws ... a divergent branch")
  // encoded the pre-fix, position-based interpretation — b and c descend from a; d is a SEPARATE
  // branch off a (a sibling of b, NOT a descendant of b) that happens to sit after c in array/file
  // order. The reviewer's ruling: an off-lineage sibling is neither kept nor dropped — it needs NO
  // confirmation and triggers NO error, because resuming at b never touches it either way.
  test("an off-lineage sibling branch is neither kept nor dropped — no confirmation required, no error", () => {
    const entries = [de("a", null), de("b", "a"), de("c", "b"), de("d", "a")];
    // c genuinely descends from b and IS dropped (needs dropsTurn); d does not and is ignored
    // entirely — dropsTurn:true must succeed (not throw over d), and kept excludes BOTH c and d.
    const kept = truncateAt(entries, { atUuid: "b", dropsTurn: true });
    expect(kept.map((e) => e.uuid)).toEqual(["a", "b"]);
  });

  test("dropsTurn:false still throws when a real (in-lineage) descendant would be dropped, even in the presence of an unrelated off-lineage sibling", () => {
    const entries = [de("a", null), de("b", "a"), de("c", "b"), de("d", "a")];
    expect(() => truncateAt(entries, { atUuid: "b", dropsTurn: false })).toThrow(ResumeTruncationError);
  });

  // --- Reviewer's pinning scenarios (fix-round 1): a file that branched via an EARLIER
  // resumeSessionAt — append order A, B, C, then (resumed at B) D, E. So file order is [A,B,C,D,E]
  // with parentUuid: B->A, C->B, D->B, E->D. C and D are SIBLING branches off B; E further extends
  // D. `entries` below is built in that exact file order (positionally), never reordered, so a
  // regression to the old position-based `truncateAt` would be caught by these two tests directly.
  function branchedFixture(): DialectEntry[] {
    return [de("A", null), de("B", "A"), de("C", "B"), de("D", "B"), de("E", "D")];
  }

  test("resumeSessionAt(D) rebuilds A,B,D — C (an off-lineage sibling of D) is excluded, not positionally included", () => {
    const entries = branchedFixture();
    const kept = truncateAt(entries, { atUuid: "D", dropsTurn: true }); // E genuinely descends from D
    expect(kept.map((e) => e.uuid)).toEqual(["A", "B", "D"]);
  });

  test("resumeSessionAt(D) with dropsTurn:false throws — E is a real descendant of D being discarded", () => {
    const entries = branchedFixture();
    expect(() => truncateAt(entries, { atUuid: "D", dropsTurn: false })).toThrow(ResumeTruncationError);
  });

  test("resumeSessionAt(C) — resuming the ALREADY-ABANDONED tip — succeeds with dropsTurn:false: neither D nor E descends from C", () => {
    const entries = branchedFixture();
    const kept = truncateAt(entries, { atUuid: "C", dropsTurn: false });
    expect(kept.map((e) => e.uuid)).toEqual(["A", "B", "C"]);
  });
});

describe("rebuildProviderMessages — Ruling P1-Q (leaf-anchored ancestry, fix-round 1)", () => {
  // The same branched fixture as truncateAt's reviewer scenarios above, but exercised as a PLAIN
  // resume (the full, untruncated entries array, as resolveEngineSession passes it when
  // config.resumeSessionAt is unset) — this is the exact "merged-context" gap this task's own
  // initial report flagged as a concern, now closed: the rebuilt context must reflect ONLY the
  // active branch (A, B, D, E), never the abandoned sibling C.
  // Assistant entries are ALWAYS array-shaped on disk — a single-text-block array for plain text
  // (assistantEntry's `content: Block[]` contract is array-always; see engine.ts's own
  // `recordAssistant([{type:"text", text: turn.text}])`) — NEVER a bare string. rebuildProviderMessages
  // collapses that single-block-array shape BACK to the bare string engine.ts's in-memory
  // accumulator actually used, so the fixtures below use the real on-disk array shape, not the
  // collapsed in-memory one (asserted separately, in the `expect(rebuilt)` below).
  function branchedFixture(): DialectEntry[] {
    return [
      { type: "user", uuid: "A", parentUuid: null, message: { role: "user", content: "A" } },
      { type: "assistant", uuid: "B", parentUuid: "A", message: { role: "assistant", content: [{ type: "text", text: "B" }] } },
      { type: "user", uuid: "C", parentUuid: "B", message: { role: "user", content: "C-abandoned" } },
      { type: "user", uuid: "D", parentUuid: "B", message: { role: "user", content: "D-active" } },
      { type: "assistant", uuid: "E", parentUuid: "D", message: { role: "assistant", content: [{ type: "text", text: "E-active" }] } },
    ];
  }

  test("a plain resume after an earlier resume-at branch rebuilds ONLY the active branch — the abandoned sibling is excluded", () => {
    const rebuilt = rebuildProviderMessages(branchedFixture());
    // Phase 6 Task 3 (R6-7): an ASSISTANT message now carries its own entry uuid -- the `anchorUuid`
    // the provider-state chain is keyed on. A user message does not (R6-7: one `origin` record per
    // ASSISTANT entry), so those assertions are unchanged.
    expect(rebuilt).toEqual([
      { role: "user", content: "A" },
      { role: "assistant", content: "B", uuid: "B" }, // collapsed back from the on-disk [{type:"text",...}] shape
      { role: "user", content: "D-active" },
      { role: "assistant", content: "E-active", uuid: "E" },
    ]);
    // the abandoned sibling's content never appears anywhere in the rebuilt context
    expect(JSON.stringify(rebuilt)).not.toContain("C-abandoned");
  });

  test("degenerates to file order for a linear (never-branched) session", () => {
    const entries: DialectEntry[] = [
      { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "hi" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
    ];
    expect(rebuildProviderMessages(entries)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", uuid: "a1" },
    ]);
  });

  // Reviewer nit 6: an EMPTY tool-result batch (engine.ts can persist `recordUser([])` when a
  // provider's tool_use turn requests zero calls — see engine.ts's unconditional
  // `await recordUser(resultBlocks)` after the tool-call loop) is unambiguously the SAME shape as a
  // non-empty tool-result batch for this engine's own producer (a user entry's content is never a
  // genuine empty array otherwise) — rebuilds as role "tool", not role "user".
  test("an empty tool-result batch rebuilds as role:tool, not role:user", () => {
    const entries: DialectEntry[] = [
      { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "go" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "t", input: {} }] } },
      { type: "user", uuid: "u2", parentUuid: "a1", message: { role: "user", content: [] } },
    ];
    const rebuilt = rebuildProviderMessages(entries);
    expect(rebuilt.at(-1)).toEqual({ role: "tool", content: [] });
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

  // Fix-round 1 coverage rider: the ONLY variant previously tested was the override going from set
  // -> UNSET. This covers the more general case the ruling's own wording ("env changed/unset") also
  // names — set -> a DIFFERENT non-empty value — which must be indistinguishable in outcome (neither
  // "custom-name-original" nor "totally-different-name" is where the session actually lives, so the
  // fallback cross-project search engages identically either way; asserted directly rather than
  // assumed).
  test("resuming by explicit id continues writing under the RECORDED name even when the override has CHANGED to a different value (not just unset)", async () => {
    const home = freshHome();
    try {
      const sessionId = randomUUID();
      const cwd = "/winter-fixture";
      const createConfig: RuntimeConfig = { sessionId, cwd, model: "sonnet" };
      await runOneEnvelope(createConfig, home, { WINTER_PROJECT_DIR_NAME: "custom-name-original" });

      const resumeConfig: RuntimeConfig = { sessionId: randomUUID(), cwd, model: "sonnet", resume: sessionId };
      await runOneEnvelope(resumeConfig, home, { WINTER_PROJECT_DIR_NAME: "totally-different-name" });

      const originalPath = join(home, "projects", "custom-name-original", `${sessionId}.jsonl`);
      const loaded = await new WinterCompatibilitySessionStore({ winterHome: home }).load({ projectKey: "custom-name-original", sessionId });
      expect(existsSync(originalPath)).toBe(true);
      expect(loaded!.length).toBe(4);

      // never lands under the NEW override name either
      const newOverridePath = join(home, "projects", "totally-different-name", `${sessionId}.jsonl`);
      expect(existsSync(newOverridePath)).toBe(false);

      const summaries = await new WinterCompatibilitySessionStore({ winterHome: home }).listSessionSummaries!("custom-name-original");
      expect(summaries[0]).toMatchObject({ projectDirName: "custom-name-original", entryCount: 4 });
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
      // Phase 5 Task 8: the continuous run shares the SPLIT run's `home`, where it used to get a
      // fresh one of its own. The two runs use different session ids, so nothing collides -- and it
      // is now load-bearing: with the assembler wired in production, every request's user message
      // carries this session's auto-memory block, whose text NAMES the resolved memory directory.
      // Two different homes therefore produce two different (correct) messages, and the comparison
      // below -- whose whole subject is "does a resumed run rebuild the same messages" -- would fail
      // on a difference that has nothing to do with resume.
      const continuousHome = home;
      try {
        // Ruling P2-I: allowedTools pre-approves both tool names so they execute — this test is
        // about resume fidelity, not permissions.
        const continuousConfig: RuntimeConfig = { sessionId: randomUUID(), cwd, model: "sonnet", allowedTools: ["good", "bad"] };
        const proc = inMemoryProcess(["--config-json", JSON.stringify(continuousConfig)], continuousProvider, throwingTools, {
          WINTER_HOME: continuousHome,
        });
        proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
        proc.stdin.write(encodeFrame({ type: "user", text: "again" }));
        proc.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
        await drainAll(proc);
        await proc.exited;
      } finally {
        // `continuousHome` IS `home`, removed by this test's own outer finally -- nothing to do here.
      }
      expect(continuousCalls.length).toBe(2);

      // --- split run: envelope 1 in run A, envelope 2 resumed in a NEW instance (run B) -----------
      const sessionId = randomUUID();
      await runOneEnvelopeCustom(
        { sessionId, cwd, model: "sonnet", allowedTools: ["good", "bad"] }, // Ruling P2-I: same pre-approval as the continuous run above
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
      // Phase 6 Task 3 (R6-7): an assistant message now carries its own entry uuid. The uuid is a
      // per-ENTRY identity minted when the entry is recorded, so two independent runs necessarily
      // mint different ones -- comparing them would assert that two sessions are the same session.
      // What the fidelity property actually claims is that the CONTENT a resumed run replays is the
      // content a continuous run would have replayed, so the anchors are compared for PRESENCE and
      // the rest for equality.
      expect(withoutAnchors(splitCalls[0]!)).toEqual(withoutAnchors(continuousCalls[1]!));
      expect(anchorPresence(splitCalls[0]!)).toEqual(anchorPresence(continuousCalls[1]!));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Whole-branch review Important 2: extends the P1-H continuous-vs-split fidelity test above to
  // P1-G (interrupted, rather than thrown). Persists an interrupted turn (assistant tool_use + a
  // synthetic interrupted:true tool_result, NO closing assistant — dialect.test.ts's own direct
  // persisted-transcript test pins that shape on-disk) then resumes it, asserting the resumed run's
  // provider sees EXACTLY what a continuous, never-resumed run would have accumulated for the same
  // choreography — the interrupted round's synthetic tool_result must round-trip through
  // resolveEngineSession's readBack/rebuildProviderMessages chain identically to a real one.
  test("resume rebuilds provider messages EXACTLY as a continuous run would, including a P1-G synthetic interrupted tool_result", async () => {
    const home = freshHome();
    try {
      const cwd = "/winter-fixture";

      // --- continuous run: both envelopes in ONE process/instance, envelope 1 interrupted ---------
      const continuousCalls: ProviderMessage[][] = [];
      let continuousExecuteEntered!: () => void;
      const continuousEntered = new Promise<void>((resolve) => {
        continuousExecuteEntered = resolve;
      });
      const continuousProvider: Provider = {
        async generate({ messages }) {
          continuousCalls.push([...messages]);
          if (continuousCalls.length === 1) {
            return { kind: "tool_use", calls: [{ id: "call1", name: "slow_tool", input: {} }] };
          }
          return { kind: "text", text: "after interrupt" };
        },
      };
      const blockingTools: ToolExecutor = {
        execute() {
          continuousExecuteEntered();
          return new Promise(() => {}); // never resolves — abandoned on interrupt
        },
      };
      // Phase 5 Task 8: the continuous run shares the SPLIT run's `home`, where it used to get a
      // fresh one of its own. The two runs use different session ids, so nothing collides -- and it
      // is now load-bearing: with the assembler wired in production, every request's user message
      // carries this session's auto-memory block, whose text NAMES the resolved memory directory.
      // Two different homes therefore produce two different (correct) messages, and the comparison
      // below -- whose whole subject is "does a resumed run rebuild the same messages" -- would fail
      // on a difference that has nothing to do with resume.
      const continuousHome = home;
      try {
        // Ruling P2-I: allowedTools:["slow_tool"] pre-approves so execution genuinely starts.
        const continuousConfig: RuntimeConfig = { sessionId: randomUUID(), cwd, model: "sonnet", allowedTools: ["slow_tool"] };
        const proc = inMemoryProcess(["--config-json", JSON.stringify(continuousConfig)], continuousProvider, blockingTools, {
          WINTER_HOME: continuousHome,
        });
        proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
        await continuousEntered; // deterministic: only interrupt once the engine is blocked inside tools.execute()
        proc.stdin.write(encodeFrame({ type: "control_request", requestId: "int1", subtype: "interrupt", payload: undefined }));
        proc.stdin.write(encodeFrame({ type: "user", text: "again" }));
        proc.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
        await drainAll(proc);
        await proc.exited;
      } finally {
        // `continuousHome` IS `home`, removed by this test's own outer finally -- nothing to do here.
      }
      expect(continuousCalls.length).toBe(2);

      // --- split run: envelope 1 (interrupted) in run A, envelope 2 resumed in a NEW instance (run B)
      const sessionId = randomUUID();
      let runAExecuteEntered!: () => void;
      const runAEntered = new Promise<void>((resolve) => {
        runAExecuteEntered = resolve;
      });
      const runABlockingTools: ToolExecutor = {
        execute() {
          runAExecuteEntered();
          return new Promise(() => {});
        },
      };
      const runAProvider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "call1", name: "slow_tool", input: {} }] }]);
      await (async () => {
        // Ruling P2-I: allowedTools:["slow_tool"] pre-approves so execution genuinely starts.
        const proc = inMemoryProcess(
          ["--config-json", JSON.stringify({ sessionId, cwd, model: "sonnet", allowedTools: ["slow_tool"] })],
          runAProvider,
          runABlockingTools,
          { WINTER_HOME: home },
        );
        proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
        await runAEntered;
        proc.stdin.write(encodeFrame({ type: "control_request", requestId: "int1", subtype: "interrupt", payload: undefined }));
        proc.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
        await drainAll(proc);
        await proc.exited;
      })();

      const splitCalls: ProviderMessage[][] = [];
      const splitProvider: Provider = {
        async generate({ messages }) {
          splitCalls.push([...messages]);
          return { kind: "text", text: "after interrupt" };
        },
      };
      await runOneEnvelopeCustom({ sessionId: randomUUID(), cwd, model: "sonnet", resume: sessionId }, home, {}, splitProvider, stubExecutor, "again");

      expect(splitCalls.length).toBe(1);
      // Phase 6 Task 3 (R6-7): an assistant message now carries its own entry uuid. The uuid is a
      // per-ENTRY identity minted when the entry is recorded, so two independent runs necessarily
      // mint different ones -- comparing them would assert that two sessions are the same session.
      // What the fidelity property actually claims is that the CONTENT a resumed run replays is the
      // content a continuous run would have replayed, so the anchors are compared for PRESENCE and
      // the rest for equality.
      expect(withoutAnchors(splitCalls[0]!)).toEqual(withoutAnchors(continuousCalls[1]!));
      expect(anchorPresence(splitCalls[0]!)).toEqual(anchorPresence(continuousCalls[1]!));
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

  // Fix-round 1 regression test (Ruling P1-Q): the ORIGINAL merged-context gap flagged in this
  // task's own initial report — a PLAIN resume (no resumeSessionAt on THIS call) of a session that
  // branched EARLIER must rebuild only the active branch, never the abandoned tail, at the full
  // engine/store stack (not just the pure rebuildProviderMessages unit above).
  test("REGRESSION: a later plain resume of a branched session rebuilds ONLY the active branch, never the abandoned tail", async () => {
    const home = freshHome();
    try {
      const cwd = "/winter-fixture";
      const sessionId = randomUUID();
      const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
      const store = new WinterCompatibilitySessionStore({ winterHome: home });

      // Two envelopes in ONE process, both echoed deterministically: u1("go")/a1("echo: go"),
      // u2("again")/a2("echo: again") — entries 0..3.
      await (async () => {
        const proc = inMemoryProcess(["--config-json", JSON.stringify({ sessionId, cwd, model: "sonnet" })], echoProvider, stubExecutor, {
          WINTER_HOME: home,
        });
        proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
        proc.stdin.write(encodeFrame({ type: "user", text: "again" }));
        proc.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
        await drainAll(proc);
        await proc.exited;
      })();

      const afterFirstRun = await store.load({ projectKey, sessionId });
      const u1Uuid = afterFirstRun![0]!.uuid!; // right after the FIRST user entry ("go")

      // Branch off u1: resumeSessionAt(u1Uuid) + one new envelope "rebranched" — abandons u2/a2
      // ("again"/"echo: again") on disk, grows a new branch off u1.
      await runOneEnvelopeCustom(
        { sessionId: randomUUID(), cwd, model: "sonnet", resume: sessionId, resumeSessionAt: u1Uuid, resumeDropsTurn: true },
        home,
        {},
        echoProvider,
        stubExecutor,
        "rebranched",
      );

      // A LATER plain resume (no resumeSessionAt) — the provider must see ONLY the active branch:
      // u1("go"), the new branch's user("rebranched")/assistant("echo: rebranched") — NEVER the
      // abandoned "again"/"echo: again" turn.
      const capturedMessages: ProviderMessage[][] = [];
      const capturingProvider: Provider = {
        async generate({ messages }) {
          capturedMessages.push([...messages]);
          return { kind: "text", text: "final" };
        },
      };
      await runOneEnvelopeCustom(
        { sessionId: randomUUID(), cwd, model: "sonnet", resume: sessionId },
        home,
        {},
        capturingProvider,
        stubExecutor,
        "final turn",
      );

      expect(capturedMessages.length).toBe(1);
      const seen = JSON.stringify(capturedMessages[0]);
      expect(seen).toContain("rebranched");
      expect(seen).not.toContain("again");
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

// --- Whole-branch review Important 1 / Ruling P1-S: eager lease acquisition at resolution --------
//
// Before this fix, resolveEngineSession never touched the writer lease until the FIRST
// recordUserEntry/recordAssistantEntry call deep inside runEngine's turn loop — and engine.ts's own
// "store failures are auxiliary, never turn-fatal" posture (WS-03 §11) SWALLOWS that failure
// silently. A resume of a session another LIVE process already held would sail straight through
// resolution, emit a normal-looking init frame, run the whole turn, and persist NOTHING — a
// "successful" run that silently threw away everything it thought it was recording. Eagerly
// claiming the lease here, before readBack/rebuild/init, means the SAME contention that
// leases.ts's acquireLease has always detected now fails typed and BEFORE any frame is written —
// exactly like an ambiguous/not-found resume target already does.
describe("Ruling P1-S: eager lease acquisition at resume resolution", () => {
  test("resuming a session whose lock is held by a DIFFERENT LIVE pid fails typed (ResumeTargetError, reason 'locked'), pre-init, and appends nothing", async () => {
    const home = freshHome();
    let dummy: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const cwd = "/winter-fixture";
      const sessionId = randomUUID();
      // A real session, genuinely resumable — the failure under test must come from the eager
      // lease check, never from findResumeTarget's own not-found path.
      await runOneEnvelope({ sessionId, cwd, model: "sonnet" }, home, {});

      const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const beforeEntries = await store.load({ projectKey, sessionId });
      const jsonlPath = join(home, "projects", projectKey, `${sessionId}.jsonl`);
      const bytesBefore = readFileSync(jsonlPath);

      // A genuinely live, otherwise-idle process — its pid is planted as the session's lease
      // holder below (identical technique to packages/sdk/src/store/crash.test.ts's lease
      // contention suite: a REAL process, never a guessed pid a real kernel might reuse mid-test).
      dummy = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 2147483647);"], { stdout: "ignore", stderr: "ignore" });
      const lockPath = join(home, "projects", projectKey, `${sessionId}.lock`);
      writeFileSync(lockPath, JSON.stringify({ pid: dummy.pid, startTimeMs: Date.now() }));

      let thrown: unknown;
      try {
        await resolveEngineSession({
          config: { sessionId: randomUUID(), cwd, model: "sonnet", resume: sessionId },
          resolveWinterHome: () => home,
          env: {},
        });
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(ResumeTargetError);
      expect((thrown as ResumeTargetError).reason).toBe("locked");

      // nothing was appended — resolution failed before ever touching the transcript
      expect(readFileSync(jsonlPath).equals(bytesBefore)).toBe(true);
      expect(await store.load({ projectKey, sessionId })).toEqual(beforeEntries);
    } finally {
      if (dummy) {
        dummy.kill("SIGKILL");
        await dummy.exited;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("end-to-end over inMemoryProcess: the SAME contention surfaces as a pre-init process failure — zero frames written, nonzero exit, never a silently-unpersisted run", async () => {
    const home = freshHome();
    let dummy: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const cwd = "/winter-fixture";
      const sessionId = randomUUID();
      await runOneEnvelope({ sessionId, cwd, model: "sonnet" }, home, {});
      const projectKey = compatibilityKeys(cwd).transcriptProjectKey;

      dummy = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 2147483647);"], { stdout: "ignore", stderr: "ignore" });
      const lockPath = join(home, "projects", projectKey, `${sessionId}.lock`);
      writeFileSync(lockPath, JSON.stringify({ pid: dummy.pid, startTimeMs: Date.now() }));

      const proc = inMemoryProcess(
        ["--config-json", JSON.stringify({ sessionId: randomUUID(), cwd, model: "sonnet", resume: sessionId })],
        undefined,
        undefined,
        { WINTER_HOME: home },
      );
      const frames = await drainAll(proc);
      const result = await proc.exited;

      // testing.ts's own resolveEngineSession try/catch: a pre-runEngine throw ends stdout with
      // NOTHING ever written and settles exited with a nonzero code — the exact shape main.ts's
      // top-level catch produces too (WS-04 §6.1 "exited before init"), which the sdk's query()
      // wrapper already maps to CLIConnectionError("runtime exited before init").
      expect(frames).toEqual([]);
      expect(result.code).not.toBe(0);
    } finally {
      if (dummy) {
        dummy.kill("SIGKILL");
        await dummy.exited;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Same-pid re-entry (T7's rule, carried by leases.ts's acquireLease): every OTHER test in this
  // file's "resume wiring end-to-end" describe above already resumes/continues a session it
  // created itself, all within this SAME test process/pid — if the eager acquire broke same-pid
  // re-entry, every one of those would fail too. No separate test needed here; recorded so a
  // reviewer doesn't go looking for one.
});

// Task 8 (WS-07 §3.3 / phase ruling 2): resolveEngineSession's own store now carries
// recordPermissionUpdate (dialect.ts's withPermissionJournal, wrapping buildWriter's result) —
// isolated from the full engine+bridge round trip (engine.test.ts's own "a real canUseTool allow
// with updatedPermissions..." covers that end-to-end); this describes ONLY the wiring: does the
// store resolveEngineSession hands back actually journal what it's told to, at the right path,
// and correctly skip an ephemeral (session/cliArg) destination.
describe("Task 8: resolveEngineSession's store journals PermissionUpdates (WS-07 §3.3 / phase ruling 2)", () => {
  test("a file-destined update is journaled as an envelope at <winterHome>/projects/<projectKey>/<sessionId>.permission-journal.jsonl", async () => {
    const home = freshHome();
    try {
      const sessionId = randomUUID();
      const cwd = "/winter-fixture";
      const { store } = await resolveEngineSession({ config: { sessionId, cwd, model: "sonnet" }, resolveWinterHome: () => home, env: {} });
      expect(store?.recordPermissionUpdate).toBeDefined();

      const update: PermissionUpdate = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf /tmp/x" }], behavior: "allow", destination: "userSettings" };
      await store!.recordPermissionUpdate!(update, "session");

      const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
      const journalPath = join(home, "projects", projectKey, `${sessionId}.permission-journal.jsonl`);
      expect(existsSync(journalPath)).toBe(true);
      const envelope = JSON.parse(readFileSync(journalPath, "utf8").trim()) as { authority: string; update: PermissionUpdate; at: string };
      expect(envelope.authority).toBe("session");
      expect(envelope.update).toEqual(update);
      expect(typeof envelope.at).toBe("string");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a session-destined update is NOT journaled (ephemeral by construction, ruleset.ts's own rule)", async () => {
    const home = freshHome();
    try {
      const sessionId = randomUUID();
      const cwd = "/winter-fixture";
      const { store } = await resolveEngineSession({ config: { sessionId, cwd, model: "sonnet" }, resolveWinterHome: () => home, env: {} });
      const update: PermissionUpdate = { type: "setMode", mode: "acceptEdits", destination: "session" };
      await store!.recordPermissionUpdate!(update, "session");

      const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
      const journalPath = join(home, "projects", projectKey, `${sessionId}.permission-journal.jsonl`);
      expect(existsSync(journalPath)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("persistSession:false: no store at all, so there is nothing to journal (matches every other SessionPersistence method's own contract)", async () => {
    const { store } = await resolveEngineSession({
      config: { sessionId: randomUUID(), cwd: "/winter-fixture", model: "sonnet", persistSession: false },
      resolveWinterHome: () => {
        throw new Error("must not be called when persistSession is false");
      },
      env: {},
    });
    expect(store).toBeUndefined();
  });
});

// Task 10 (WS-08 §9 Amended / P2-A: "the AUDIT stream ... MUST carry all of it per invocation"):
// resolveEngineSession's own store now ALSO carries recordHookAudit (dialect.ts's
// withPermissionJournal, wrapping the SAME buildWriter result recordPermissionUpdate uses above) —
// isolated from the full engine+bridge round trip (engine.test.ts's own hooked-tool-round tests
// cover that end-to-end); this describes ONLY the wiring: does the store resolveEngineSession hands
// back actually journal a hook audit record, at the SAME journal file recordPermissionUpdate uses,
// as the distinguishable sibling envelope kind appendHookAuditJournal's own header documents.
describe("Task 10: resolveEngineSession's store journals hook audit records (WS-08 §9 Amended / P2-A)", () => {
  test("a hook audit record is journaled as a {kind:'hookAudit', at, entry} envelope at the SAME <winterHome>/projects/<projectKey>/<sessionId>.permission-journal.jsonl path", async () => {
    const home = freshHome();
    try {
      const sessionId = randomUUID();
      const cwd = "/winter-fixture";
      const { store } = await resolveEngineSession({ config: { sessionId, cwd, model: "sonnet" }, resolveWinterHome: () => home, env: {} });
      expect(store?.recordHookAudit).toBeDefined();

      const entry: HookAuditRecord = {
        hookId: "PreToolUse:sdk:0:0",
        hookEvent: "PreToolUse",
        sessionId,
        uuid: randomUUID(),
        toolUseID: "call-1",
        outcome: "decision",
        decision: "allow",
      };
      await store!.recordHookAudit!(entry);

      const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
      const journalPath = join(home, "projects", projectKey, `${sessionId}.permission-journal.jsonl`);
      expect(existsSync(journalPath)).toBe(true);
      const envelope = JSON.parse(readFileSync(journalPath, "utf8").trim()) as { kind: string; entry: HookAuditRecord; at: string };
      expect(envelope.kind).toBe("hookAudit");
      expect(envelope.entry).toEqual(entry);
      expect(typeof envelope.at).toBe("string");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a hook audit record and a PermissionUpdate coexist in the SAME journal file across the SAME resolveEngineSession store, in append order", async () => {
    const home = freshHome();
    try {
      const sessionId = randomUUID();
      const cwd = "/winter-fixture";
      const { store } = await resolveEngineSession({ config: { sessionId, cwd, model: "sonnet" }, resolveWinterHome: () => home, env: {} });

      const update: PermissionUpdate = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls *" }], behavior: "allow", destination: "userSettings" };
      await store!.recordPermissionUpdate!(update, "session");
      const entry: HookAuditRecord = { hookId: "Stop:sdk:0:0", hookEvent: "Stop", sessionId, uuid: randomUUID(), outcome: "none" };
      await store!.recordHookAudit!(entry);

      const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
      const journalPath = join(home, "projects", projectKey, `${sessionId}.permission-journal.jsonl`);
      const lines = readFileSync(journalPath, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as { kind?: string; update?: PermissionUpdate; entry?: HookAuditRecord });
      expect(lines).toHaveLength(2);
      expect(lines[0]!.kind).toBeUndefined();
      expect(lines[0]!.update).toEqual(update);
      expect(lines[1]!.kind).toBe("hookAudit");
      expect(lines[1]!.entry).toEqual(entry);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("persistSession:false: no store at all, so there is nothing to journal (matches recordPermissionUpdate's own identical contract)", async () => {
    const { store } = await resolveEngineSession({
      config: { sessionId: randomUUID(), cwd: "/winter-fixture", model: "sonnet", persistSession: false },
      resolveWinterHome: () => {
        throw new Error("must not be called when persistSession is false");
      },
      env: {},
    });
    expect(store).toBeUndefined();
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

/** Strips the per-entry anchor uuid so two independent runs' histories can be compared for CONTENT. */
function withoutAnchors(messages: readonly ProviderMessage[]): ProviderMessage[] {
  return messages.map(({ uuid: _uuid, ...rest }) => rest);
}

/** Which messages carry an anchor at all -- the half of the fidelity claim that survives across runs. */
function anchorPresence(messages: readonly ProviderMessage[]): boolean[] {
  return messages.map((m) => m.uuid !== undefined);
}
