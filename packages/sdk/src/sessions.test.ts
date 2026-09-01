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
import { WinterCompatibilitySessionStore } from "./store/session-store.ts";
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
});
