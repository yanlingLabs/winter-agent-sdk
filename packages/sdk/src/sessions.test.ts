// Task 10 (WS-03 §3.1): the standalone session-management API. These functions run OUTSIDE an
// active query, directly against the transcript store (WinterCompatibilitySessionStore) — no
// engine, no provider. Every fixture home below is a fresh mkdtemp under the OS temp dir — never
// ~/.winter, ~/.norma, ~/.claude, or a real shared path. cwd fixtures are synthetic
// ("/winter-fixture-sessions-*") so a derived projectKey never embeds a real username.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listSessions,
  getSessionInfo,
  getSessionMessages,
  renameSession,
  tagSession,
  deleteSession,
  forkSession,
  listSubagents,
  getSubagentMessages,
} from "./sessions.ts";
import { SessionNotFoundError } from "./errors.ts";
import { WinterCompatibilitySessionStore, DIALECT_RECORD_ENTRY_TYPE } from "./store/session-store.ts";
import { compatibilityKeys } from "./paths/keys.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "winter-sessions-test-"));
}

const DIR_A = "/winter-fixture-sessions-a";
const DIR_B = "/winter-fixture-sessions-b";

function projectKeyFor(dir: string): string {
  return compatibilityKeys(dir).transcriptProjectKey;
}

let seq = 0;
async function seedSession(store: WinterCompatibilitySessionStore, projectKey: string, sessionId: string): Promise<void> {
  seq += 1;
  const uUuid = `${sessionId}-u${seq}`;
  const aUuid = `${sessionId}-a${seq}`;
  await store.append({ projectKey, sessionId }, [
    { type: "user", uuid: uUuid, parentUuid: null, sessionId, message: { role: "user", content: `hello from ${sessionId}` } },
    { type: "assistant", uuid: aUuid, parentUuid: uUuid, sessionId, message: { role: "assistant", content: `reply from ${sessionId}` } },
  ]);
}

// The brief's own fixture shape: two projects x two sessions.
async function seedTwoByTwo(home: string): Promise<{ store: WinterCompatibilitySessionStore; projectA: string; projectB: string }> {
  const store = new WinterCompatibilitySessionStore({ winterHome: home });
  const projectA = projectKeyFor(DIR_A);
  const projectB = projectKeyFor(DIR_B);
  await seedSession(store, projectA, "session-a1");
  await seedSession(store, projectA, "session-a2");
  await seedSession(store, projectB, "session-b1");
  await seedSession(store, projectB, "session-b2");
  return { store, projectA, projectB };
}

describe("listSessions", () => {
  test("omitted directory lists sessions across every project", async () => {
    const home = freshHome();
    try {
      const { projectA, projectB } = await seedTwoByTwo(home);
      const result = await listSessions({ winterHome: home });
      expect(result.length).toBe(4);
      expect(result.map((s) => s.sessionId).sort()).toEqual(["session-a1", "session-a2", "session-b1", "session-b2"]);
      const a1 = result.find((s) => s.sessionId === "session-a1")!;
      expect(a1.projectKey).toBe(projectA);
      expect(typeof a1.mtime).toBe("number");
      expect(a1.name).toBeUndefined();
      expect(a1.tags).toBeUndefined();
      const b1 = result.find((s) => s.sessionId === "session-b1")!;
      expect(b1.projectKey).toBe(projectB);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a supplied directory constrains listing to that project's sessions only", async () => {
    const home = freshHome();
    try {
      const { projectA } = await seedTwoByTwo(home);
      const result = await listSessions({ directory: DIR_A, winterHome: home });
      expect(result.length).toBe(2);
      for (const s of result) expect(s.projectKey).toBe(projectA);
      expect(result.map((s) => s.sessionId).sort()).toEqual(["session-a1", "session-a2"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a directory with no sessions returns an empty array, not an error", async () => {
    const home = freshHome();
    try {
      const result = await listSessions({ directory: "/winter-fixture-sessions-nothing-here", winterHome: home });
      expect(result).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reflects renamed/tagged metadata from the summary sidecar", async () => {
    const home = freshHome();
    try {
      await seedTwoByTwo(home);
      await renameSession("session-a1", "My Session", { winterHome: home });
      await tagSession("session-a1", ["work", "important"], { winterHome: home });

      const result = await listSessions({ directory: DIR_A, winterHome: home });
      const a1 = result.find((s) => s.sessionId === "session-a1")!;
      expect(a1.name).toBe("My Session");
      expect(a1.tags).toEqual(["work", "important"]);
      const a2 = result.find((s) => s.sessionId === "session-a2")!;
      expect(a2.name).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("getSessionInfo", () => {
  test("returns the resolved shape for a known session, searching all projects when directory is omitted", async () => {
    const home = freshHome();
    try {
      const { projectA } = await seedTwoByTwo(home);
      const info = await getSessionInfo("session-a1", { winterHome: home });
      expect(info.sessionId).toBe("session-a1");
      expect(info.projectKey).toBe(projectA);
      expect(info.entryCount).toBe(2); // one user + one assistant entry
      expect(typeof info.mtime).toBe("number");
      expect(info.name).toBeUndefined();
      expect(info.tags).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a supplied directory constrains lookup to that project", async () => {
    const home = freshHome();
    try {
      const { projectB } = await seedTwoByTwo(home);
      const info = await getSessionInfo("session-b1", { directory: DIR_B, winterHome: home });
      expect(info.projectKey).toBe(projectB);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("throws a typed not-found error for an id that exists nowhere", async () => {
    const home = freshHome();
    try {
      await seedTwoByTwo(home);
      let thrown: unknown;
      try {
        await getSessionInfo("does-not-exist", { winterHome: home });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SessionNotFoundError);
      expect((thrown as SessionNotFoundError).reason).toBe("not_found");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("throws a typed not-found error when a directory is supplied but the session lives elsewhere -- never falls back to searching other projects", async () => {
    const home = freshHome();
    try {
      await seedTwoByTwo(home);
      let thrown: unknown;
      try {
        await getSessionInfo("session-a1", { directory: DIR_B, winterHome: home });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SessionNotFoundError);
      expect((thrown as SessionNotFoundError).reason).toBe("not_found");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("throws a typed ambiguous error when the id exists in more than one project and no directory is supplied; a directory resolves it", async () => {
    const home = freshHome();
    try {
      const { store, projectA, projectB } = await seedTwoByTwo(home);
      await seedSession(store, projectA, "shared-id");
      await seedSession(store, projectB, "shared-id");

      let thrown: unknown;
      try {
        await getSessionInfo("shared-id", { winterHome: home });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SessionNotFoundError);
      expect((thrown as SessionNotFoundError).reason).toBe("ambiguous");

      const info = await getSessionInfo("shared-id", { directory: DIR_A, winterHome: home });
      expect(info.projectKey).toBe(projectA);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("falls back to load() for entryCount when the summary sidecar is missing", async () => {
    const home = freshHome();
    try {
      const { projectA } = await seedTwoByTwo(home);
      const summaryPath = join(home, "projects", projectA, "session-a1.summary.json");
      expect(existsSync(summaryPath)).toBe(true); // sanity: append() really did create one
      rmSync(summaryPath);

      const info = await getSessionInfo("session-a1", { winterHome: home });
      expect(info.entryCount).toBe(2); // recovered via load(), never silently 0
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("getSessionMessages", () => {
  test("returns the exact opaque entries for a known session", async () => {
    const home = freshHome();
    try {
      await seedTwoByTwo(home);
      const messages = await getSessionMessages("session-a1", { winterHome: home });
      expect(messages.length).toBe(2);
      expect(messages[0]!.type).toBe("user");
      expect(messages[1]!.type).toBe("assistant");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("throws a typed not-found error for an unknown id", async () => {
    const home = freshHome();
    try {
      await seedTwoByTwo(home);
      await expect(getSessionMessages("nope", { winterHome: home })).rejects.toBeInstanceOf(SessionNotFoundError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("renameSession / tagSession -- merge semantics", () => {
  test("tagging after renaming preserves the name; renaming after tagging preserves the tags", async () => {
    const home = freshHome();
    try {
      await seedTwoByTwo(home);
      await renameSession("session-a1", "First Pass", { winterHome: home });
      await tagSession("session-a1", ["alpha"], { winterHome: home });
      let info = await getSessionInfo("session-a1", { winterHome: home });
      expect(info.name).toBe("First Pass");
      expect(info.tags).toEqual(["alpha"]);

      await renameSession("session-a1", "Second Pass", { winterHome: home });
      info = await getSessionInfo("session-a1", { winterHome: home });
      expect(info.name).toBe("Second Pass");
      expect(info.tags).toEqual(["alpha"]); // untouched by the rename

      await tagSession("session-a1", ["beta", "gamma"], { winterHome: home });
      info = await getSessionInfo("session-a1", { winterHome: home });
      expect(info.name).toBe("Second Pass"); // untouched by the re-tag
      expect(info.tags).toEqual(["beta", "gamma"]); // replaced wholesale
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("renaming preserves the mechanical entryCount already folded into the summary", async () => {
    const home = freshHome();
    try {
      await seedTwoByTwo(home);
      const before = await getSessionInfo("session-a1", { winterHome: home });
      await renameSession("session-a1", "Named", { winterHome: home });
      const after = await getSessionInfo("session-a1", { winterHome: home });
      expect(after.entryCount).toBe(before.entryCount);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("throw a typed not-found error for an unknown id", async () => {
    const home = freshHome();
    try {
      await seedTwoByTwo(home);
      await expect(renameSession("nope", "x", { winterHome: home })).rejects.toBeInstanceOf(SessionNotFoundError);
      await expect(tagSession("nope", ["x"], { winterHome: home })).rejects.toBeInstanceOf(SessionNotFoundError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// Fix round 1: mergeSessionMetadata (session-store.ts) and foldSummary (session-store.ts, the
// dialect-record/mechanical-field folding append() already does) are two INDEPENDENT
// read-modify-write producers of the exact same <sessionId>.summary.json sidecar. Both directions
// need proving, mirroring the established template for exactly this risk
// (session-store.test.ts's "dialect fields survive a later plain append" — same file, same
// producers, same non-clobbering claim, just approached from the OTHER new producer's side).
// These are pinning tests: they assert the CURRENT (already-correct-by-construction) spread
// orders in both functions, run pass-first against unchanged implementation code.
describe("mergeSessionMetadata vs foldSummary -- two independent producers of the same summary sidecar", () => {
  test("renameSession/tagSession preserve dialect-record fields a prior append already folded into the summary", async () => {
    const home = freshHome();
    try {
      const { store, projectA } = await seedTwoByTwo(home);
      // A dialect-record append (Task 8's own sentinel, re-exported unchanged from this same
      // module) folds producer/dialect fields PLUS a projectDirName-style extension field into the
      // summary — exactly what dialect.ts's real TranscriptWriter does on every turn.
      await store.append({ projectKey: projectA, sessionId: "session-a1" }, [
        {
          type: DIALECT_RECORD_ENTRY_TYPE,
          producerRuntime: "winter-agent",
          producerEngineVersion: "0.0.1",
          dialectFamily: "claude-code-jsonl",
          projectDirName: projectA,
        },
      ]);

      await renameSession("session-a1", "Renamed", { winterHome: home });
      await tagSession("session-a1", ["tagged"], { winterHome: home });

      // Round-trip via listSessionSummaries -- the only vantage point that can see the raw
      // dialect fields at all (getSessionInfo's own shape doesn't surface them).
      const summaries = await store.listSessionSummaries(projectA);
      const summary = summaries.find((s) => s.sessionId === "session-a1");
      expect(summary).toMatchObject({
        entryCount: 2, // mechanical field from the earlier seedSession append, untouched by either merge
        producerRuntime: "winter-agent", // NOT clobbered by mergeSessionMetadata's later writes
        producerEngineVersion: "0.0.1",
        dialectFamily: "claude-code-jsonl",
        projectDirName: projectA,
        name: "Renamed",
        tags: ["tagged"],
      });

      // Round-trip via getSessionInfo -- the fields it DOES surface must also be correct and
      // undisturbed by the dialect-record append that came before the renames.
      const info = await getSessionInfo("session-a1", { winterHome: home });
      expect(info.name).toBe("Renamed");
      expect(info.tags).toEqual(["tagged"]);
      expect(info.entryCount).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a later plain append's foldSummary preserves name/tags set earlier via renameSession/tagSession, while still updating mechanical fields", async () => {
    const home = freshHome();
    try {
      const { store, projectA } = await seedTwoByTwo(home); // session-a1 starts at entryCount:2
      await renameSession("session-a1", "Live Session", { winterHome: home });
      await tagSession("session-a1", ["ongoing"], { winterHome: home });

      // A plain, sentinel-less append -- exactly what a live session continuing looks like from
      // the store's point of view (dialect.ts's real TranscriptWriter does this every turn).
      await store.append({ projectKey: projectA, sessionId: "session-a1" }, [
        { type: "user", uuid: "extra-u1", parentUuid: null, sessionId: "session-a1", message: { role: "user", content: "more" } },
      ]);

      const summaries = await store.listSessionSummaries(projectA);
      const summary = summaries.find((s) => s.sessionId === "session-a1");
      expect(summary).toMatchObject({
        entryCount: 3, // mechanical field kept updating (2 + 1) -- foldSummary's OWN job
        name: "Live Session", // NOT clobbered by the sentinel-less, name/tags-less append
        tags: ["ongoing"],
      });

      const info = await getSessionInfo("session-a1", { winterHome: home });
      expect(info.entryCount).toBe(3);
      expect(info.name).toBe("Live Session");
      expect(info.tags).toEqual(["ongoing"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("renameSession with no summary sidecar yet produces a persisted summary with no entryCount key", async () => {
    const home = freshHome();
    try {
      const { projectA } = await seedTwoByTwo(home);
      const summaryPath = join(home, "projects", projectA, "session-a1.summary.json");
      rmSync(summaryPath);

      await renameSession("session-a1", "Fresh Metadata", { winterHome: home });

      // mergeSessionMetadata's patch-then-cast path never re-derives entryCount from scratch --
      // the same posture the pre-existing foldSummary already has for a dialect-only append with
      // zero native entries (its own `mechanical` object stays `{}` and contributes no entryCount
      // key either). Pinning current, correct behavior -- not requesting a change.
      const raw = JSON.parse(readFileSync(summaryPath, "utf8")) as Record<string, unknown>;
      expect(raw["name"]).toBe("Fresh Metadata");
      expect("entryCount" in raw).toBe(false);

      // getSessionInfo's own load()-fallback (see its dedicated test above) is what keeps this
      // from ever surfacing as a wrong/missing entryCount to a caller.
      const info = await getSessionInfo("session-a1", { winterHome: home });
      expect(info.entryCount).toBe(2); // recovered via load(), not the (absent) summary field
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("deleteSession", () => {
  test("cascades: removes the session and leaves its project sibling untouched", async () => {
    const home = freshHome();
    try {
      const { projectA } = await seedTwoByTwo(home);
      await deleteSession("session-a1", { winterHome: home });

      await expect(getSessionInfo("session-a1", { winterHome: home })).rejects.toBeInstanceOf(SessionNotFoundError);
      const remaining = await listSessions({ directory: DIR_A, winterHome: home });
      expect(remaining.map((s) => s.sessionId)).toEqual(["session-a2"]);

      const stem = join(home, "projects", projectA, "session-a1");
      expect(existsSync(`${stem}.jsonl`)).toBe(false);
      expect(existsSync(`${stem}.summary.json`)).toBe(false);
      expect(existsSync(`${stem}.lock`)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("throws a typed not-found error for an unknown id", async () => {
    const home = freshHome();
    try {
      await seedTwoByTwo(home);
      await expect(deleteSession("nope", { winterHome: home })).rejects.toBeInstanceOf(SessionNotFoundError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("forkSession", () => {
  test("copies a session's entries into a new id in the SAME project, leaving the source untouched", async () => {
    const home = freshHome();
    try {
      const { projectA } = await seedTwoByTwo(home);
      const sourcePath = join(home, "projects", projectA, "session-a1.jsonl");
      const before = readFileSync(sourcePath);

      const { sessionId: forkedId } = await forkSession("session-a1", { winterHome: home });
      expect(forkedId).not.toBe("session-a1");
      expect(readFileSync(sourcePath).equals(before)).toBe(true);

      const info = await getSessionInfo(forkedId, { winterHome: home });
      expect(info.projectKey).toBe(projectA);
      expect(info.entryCount).toBe(2);

      const messages = await getSessionMessages(forkedId, { winterHome: home });
      expect(messages.length).toBe(2);
      for (const m of messages) expect(m.sessionId).toBe(forkedId);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("throws a typed not-found error for an unknown id", async () => {
    const home = freshHome();
    try {
      await seedTwoByTwo(home);
      await expect(forkSession("nope", { winterHome: home })).rejects.toBeInstanceOf(SessionNotFoundError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a supplied directory resolves which same-named session gets forked", async () => {
    const home = freshHome();
    try {
      const { store, projectA, projectB } = await seedTwoByTwo(home);
      await seedSession(store, projectA, "shared-id");
      await seedSession(store, projectB, "shared-id");

      const { sessionId: forkedId } = await forkSession("shared-id", { directory: DIR_B, winterHome: home });
      const info = await getSessionInfo(forkedId, { winterHome: home });
      expect(info.projectKey).toBe(projectB);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("listSubagents / getSubagentMessages", () => {
  test("an empty array before P4 populates any subagent subkeys", async () => {
    const home = freshHome();
    try {
      await seedTwoByTwo(home);
      const agents = await listSubagents("session-a1", { winterHome: home });
      expect(agents).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("surfaces a seeded subagent subkey with its subagents/ prefix stripped", async () => {
    const home = freshHome();
    try {
      const { store, projectA } = await seedTwoByTwo(home);
      await store.append({ projectKey: projectA, sessionId: "session-a1", subpath: "subagents/agent-1" }, [
        { type: "user", uuid: "sub-u1", parentUuid: null, message: { role: "user", content: "sub task" } },
      ]);

      const agents = await listSubagents("session-a1", { winterHome: home });
      expect(agents).toEqual([{ agentId: "agent-1" }]);

      const messages = await getSubagentMessages("session-a1", "agent-1", { winterHome: home });
      expect(messages.length).toBe(1);
      expect(messages[0]!.type).toBe("user");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("getSubagentMessages throws a typed not-found error for an unknown agentId", async () => {
    const home = freshHome();
    try {
      await seedTwoByTwo(home);
      await expect(getSubagentMessages("session-a1", "ghost", { winterHome: home })).rejects.toBeInstanceOf(SessionNotFoundError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("listSubagents/getSubagentMessages throw not-found for an unknown outer sessionId", async () => {
    const home = freshHome();
    try {
      await seedTwoByTwo(home);
      await expect(listSubagents("nope", { winterHome: home })).rejects.toBeInstanceOf(SessionNotFoundError);
      await expect(getSubagentMessages("nope", "agent-1", { winterHome: home })).rejects.toBeInstanceOf(SessionNotFoundError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("winterHome resolution", () => {
  test("falls back to the resolver default (WINTER_HOME) when opts.winterHome is omitted", async () => {
    const home = freshHome();
    const original = process.env.WINTER_HOME;
    process.env.WINTER_HOME = home;
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      await seedSession(store, projectKeyFor(DIR_A), "env-default-session");

      const result = await listSessions({ directory: DIR_A });
      expect(result.map((s) => s.sessionId)).toEqual(["env-default-session"]);
    } finally {
      if (original === undefined) delete process.env.WINTER_HOME;
      else process.env.WINTER_HOME = original;
      rmSync(home, { recursive: true, force: true });
    }
  });

  // --- P7a fix wave (item 5, whole-branch review I-1) ---------------------------------------------
  //
  // These nine functions run OUTSIDE a query, so nothing hands them a `RuntimeConfig` and the brand
  // has to arrive as an option. It did not, and `resolveHome` called `resolveWinterHome()` with no
  // brand at all -- which reads `WINTER_HOME` and `~/.winter`. A D19 tier-1 reuser's `listSessions()`
  // therefore addressed WINTER's store, and on a machine where Winter is also installed
  // `deleteSession(id)` from the reuser's app deleted a Winter session.
  //
  // BOTH DIRECTIONS ARE ASSERTED. A branded call finding the branded store proves the argument is
  // threaded; the UNBRANDED call NOT finding it (while finding Winter's own decoy instead) is what
  // proves the two homes are genuinely distinct rather than the test having pointed both at one.
  test("P7a (I-1): a BRANDED call reads the brand's own home, and an unbranded call reads Winter's", async () => {
    const acmeHome = freshHome();
    const winterHome = freshHome();
    const ACME = { productName: "Acme", homeDirName: ".acme", envPrefix: "ACME_", packageName: "acme", mcpServerName: "acme", codexOriginator: "acme", tempRootName: "acme" } as const;
    const originalWinter = process.env.WINTER_HOME;
    const originalAcme = process.env.ACME_HOME;
    process.env.WINTER_HOME = winterHome;
    process.env.ACME_HOME = acmeHome;
    try {
      await seedSession(new WinterCompatibilitySessionStore({ winterHome: acmeHome }), projectKeyFor(DIR_A), "acme-session");
      await seedSession(new WinterCompatibilitySessionStore({ winterHome }), projectKeyFor(DIR_A), "winter-decoy-session");

      // The brand's OWN env name is what resolves the home -- `ACME_HOME`, derived, never spelled.
      expect((await listSessions({ directory: DIR_A, brand: ACME })).map((x) => x.sessionId)).toEqual(["acme-session"]);
      // ...and Winter's own default is untouched, which is what makes the assertion above meaningful.
      expect((await listSessions({ directory: DIR_A })).map((x) => x.sessionId)).toEqual(["winter-decoy-session"]);

      // The destructive one, because it is the one the review names: a reuser's delete must not be
      // able to reach a Winter session of the same id.
      await deleteSession("acme-session", { directory: DIR_A, brand: ACME });
      expect(await listSessions({ directory: DIR_A, brand: ACME })).toEqual([]);
      expect((await listSessions({ directory: DIR_A })).map((x) => x.sessionId)).toEqual(["winter-decoy-session"]);
    } finally {
      if (originalWinter === undefined) delete process.env.WINTER_HOME;
      else process.env.WINTER_HOME = originalWinter;
      if (originalAcme === undefined) delete process.env.ACME_HOME;
      else process.env.ACME_HOME = originalAcme;
      rmSync(acmeHome, { recursive: true, force: true });
      rmSync(winterHome, { recursive: true, force: true });
    }
  });

  test("P7a (I-1): an explicit `winterHome` still wins over `brand`, and an INVALID brand refuses rather than falling back", async () => {
    const explicit = freshHome();
    const decoy = freshHome();
    const originalAcme = process.env.ACME_HOME;
    process.env.ACME_HOME = decoy;
    try {
      await seedSession(new WinterCompatibilitySessionStore({ winterHome: explicit }), projectKeyFor(DIR_A), "explicit-session");
      expect((await listSessions({ directory: DIR_A, winterHome: explicit, brand: { homeDirName: ".acme", envPrefix: "ACME_" } })).map((x) => x.sessionId)).toEqual(["explicit-session"]);

      // A malformed profile must REFUSE. Falling back to Winter's home is the exact failure the
      // field exists to prevent -- the caller asked for their store and would silently get Winter's.
      await expect(listSessions({ directory: DIR_A, brand: { homeDirName: "acme" } })).rejects.toThrow(/homeDirName/);
    } finally {
      if (originalAcme === undefined) delete process.env.ACME_HOME;
      else process.env.ACME_HOME = originalAcme;
      rmSync(explicit, { recursive: true, force: true });
      rmSync(decoy, { recursive: true, force: true });
    }
  });
});
