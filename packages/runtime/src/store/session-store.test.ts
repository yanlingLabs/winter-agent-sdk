// Independently authored conformance suite (Task 7) — categories drawn from WS-05 §6's own list
// (append/load ordering; null for unknown keys; empty append no-op; project isolation;
// main/subpath isolation; list + mtime monotonicity; delete cascade; subkey enumeration), plus the
// brief's additional "Required behavior" items (permissions, agent_metadata partitioning, subpath
// validation) that aren't one of those eight named categories but are still spec'd musts. Crash
// scenarios (torn line / kill-during-append / lease contention) live in crash.test.ts.
//
// Every winterHome in this file is a fresh mkdtemp under the OS temp dir — never ~/.winter,
// ~/.norma, ~/.claude, or a real shared path. No real usernames appear anywhere below.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, statSync, lstatSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WinterCompatibilitySessionStore, WinterStoreError, type SessionStoreEntry } from "./session-store.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "winter-store-test-"));
}

let seq = 0;
function entry(overrides: Partial<SessionStoreEntry> = {}): SessionStoreEntry {
  seq += 1;
  return { type: "test_entry", uuid: `uuid-${seq}`, timestamp: new Date(2020, 0, 1, 0, 0, seq).toISOString(), seq, ...overrides };
}

describe("append/load ordering", () => {
  test("a single append round-trips in order", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-a", sessionId: "sess-1" };
      const e1 = entry();
      const e2 = entry();
      await store.append(key, [e1, e2]);
      const loaded = await store.load(key);
      expect(loaded).toEqual([e1, e2]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("entries across multiple separate append() calls preserve call order, not just within-call order", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-a", sessionId: "sess-2" };
      const e1 = entry();
      const e2 = entry();
      const e3 = entry();
      await store.append(key, [e1]);
      await store.append(key, [e2, e3]);
      const loaded = await store.load(key);
      expect(loaded).toEqual([e1, e2, e3]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("no dedup of UUID-less entries — repeated identical entries all survive", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-a", sessionId: "sess-3" };
      const marker = { type: "mode_marker" }; // deliberately no uuid
      await store.append(key, [marker, marker, marker]);
      const loaded = await store.load(key);
      expect(loaded).toEqual([marker, marker, marker]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("null for unknown keys", () => {
  test("load() on a session that was never appended returns null, not []", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const loaded = await store.load({ projectKey: "proj-a", sessionId: "never-existed" });
      expect(loaded).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("load() on an unknown projectKey also returns null (no directory ever created for it)", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const loaded = await store.load({ projectKey: "never-touched-project", sessionId: "sess-x" });
      expect(loaded).toBeNull();
      expect(existsSync(join(home, "projects", "never-touched-project"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("empty append is a no-op", () => {
  test("append(key, []) creates nothing on disk and load() still returns null", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-a", sessionId: "sess-empty" };
      await store.append(key, []);
      expect(await store.load(key)).toBeNull();
      expect(existsSync(join(home, "projects", "proj-a"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("append(key, []) after real entries exist does not change mtime or content", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-a", sessionId: "sess-empty-2" };
      await store.append(key, [entry()]);
      const path = join(home, "projects", "proj-a", "sess-empty-2.jsonl");
      const before = statSync(path);
      await new Promise((r) => setTimeout(r, 5));
      await store.append(key, []);
      const after = statSync(path);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.size).toBe(before.size);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("project isolation", () => {
  test("two projects with the identical sessionId never see each other's entries", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const eA = entry({ type: "from_a" });
      const eB = entry({ type: "from_b" });
      await store.append({ projectKey: "proj-a", sessionId: "shared-id" }, [eA]);
      await store.append({ projectKey: "proj-b", sessionId: "shared-id" }, [eB]);

      expect(await store.load({ projectKey: "proj-a", sessionId: "shared-id" })).toEqual([eA]);
      expect(await store.load({ projectKey: "proj-b", sessionId: "shared-id" })).toEqual([eB]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("main/subpath isolation", () => {
  test("the main session and a subagent subpath under the SAME sessionId never mix entries", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-a", sessionId: "sess-parent" };
      const subKey = { ...key, subpath: "subagents/agent-a123" };
      const mainEntry = entry({ type: "main_entry" });
      const subEntry = entry({ type: "sub_entry" });

      await store.append(key, [mainEntry]);
      await store.append(subKey, [subEntry]);

      expect(await store.load(key)).toEqual([mainEntry]);
      expect(await store.load(subKey)).toEqual([subEntry]);

      // and on disk they are genuinely two different files, not one shadowing the other
      const mainPath = join(home, "projects", "proj-a", "sess-parent.jsonl");
      const subPath = join(home, "projects", "proj-a", "sess-parent", "subagents", "agent-a123.jsonl");
      expect(existsSync(mainPath)).toBe(true);
      expect(existsSync(subPath)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("two different subpaths under the same session are mutually isolated too", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-a", sessionId: "sess-parent-2" };
      const subA = { ...key, subpath: "subagents/agent-a" };
      const subB = { ...key, subpath: "subagents/agent-b" };
      const eA = entry({ type: "a" });
      const eB = entry({ type: "b" });
      await store.append(subA, [eA]);
      await store.append(subB, [eB]);
      expect(await store.load(subA)).toEqual([eA]);
      expect(await store.load(subB)).toEqual([eB]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("list + mtime monotonicity", () => {
  test("listSessions reports every appended session with its file mtime", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      await store.append({ projectKey: "proj-list", sessionId: "s1" }, [entry()]);
      await store.append({ projectKey: "proj-list", sessionId: "s2" }, [entry()]);

      const listed = await store.listSessions("proj-list");
      const ids = listed.map((s) => s.sessionId).sort();
      expect(ids).toEqual(["s1", "s2"]);
      for (const s of listed) expect(typeof s.mtime).toBe("number");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("listSessions on a project with no sessions returns []", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      expect(await store.listSessions("no-such-project")).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a later append strictly increases mtime (monotonic, not just non-decreasing)", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-list", sessionId: "s3" };
      await store.append(key, [entry()]);
      const first = (await store.listSessions("proj-list")).find((s) => s.sessionId === "s3");
      expect(first).toBeDefined();

      await new Promise((r) => setTimeout(r, 10));
      await store.append(key, [entry()]);
      const second = (await store.listSessions("proj-list")).find((s) => s.sessionId === "s3");
      expect(second).toBeDefined();

      expect(second!.mtime).toBeGreaterThan(first!.mtime);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("listSessions never surfaces a subagent subpath as its own top-level session", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-list2", sessionId: "parent" };
      await store.append({ ...key, subpath: "subagents/agent-x" }, [entry()]);
      // the subagent file lives at proj-list2/parent/subagents/agent-x.jsonl — never a flat
      // proj-list2/<something>.jsonl of its own
      expect(await store.listSessions("proj-list2")).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("delete cascade", () => {
  test("deleting a session removes its main jsonl AND its entire subagent subtree", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-del", sessionId: "to-delete" };
      await store.append(key, [entry()]);
      await store.append({ ...key, subpath: "subagents/agent-a" }, [entry()]);
      await store.append({ ...key, subpath: "subagents/agent-b" }, [entry()]);

      const mainPath = join(home, "projects", "proj-del", "to-delete.jsonl");
      const sessionDir = join(home, "projects", "proj-del", "to-delete");
      expect(existsSync(mainPath)).toBe(true);
      expect(existsSync(sessionDir)).toBe(true);

      await store.delete(key);

      expect(existsSync(mainPath)).toBe(false);
      expect(existsSync(sessionDir)).toBe(false);
      expect(await store.load(key)).toBeNull();
      expect(await store.load({ ...key, subpath: "subagents/agent-a" })).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("deleting one session never touches a sibling session in the same project", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const keep = { projectKey: "proj-del2", sessionId: "keep-me" };
      const gone = { projectKey: "proj-del2", sessionId: "delete-me" };
      const keptEntry = entry();
      await store.append(keep, [keptEntry]);
      await store.append(gone, [entry()]);

      await store.delete(gone);

      expect(await store.load(gone)).toBeNull();
      expect(await store.load(keep)).toEqual([keptEntry]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("deleting a nonexistent session is a harmless no-op", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      await expect(store.delete({ projectKey: "proj-del3", sessionId: "nope" })).resolves.toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("subkey enumeration", () => {
  test("listSubkeys reports exactly the subpaths that were appended, nothing more or less", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-sub", sessionId: "parent" };
      await store.append(key, [entry()]); // main entry — must NOT appear as a subkey
      await store.append({ ...key, subpath: "subagents/agent-a" }, [entry()]);
      await store.append({ ...key, subpath: "subagents/agent-b" }, [entry()]);

      const subkeys = (await store.listSubkeys(key)).sort();
      expect(subkeys).toEqual(["subagents/agent-a", "subagents/agent-b"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("listSubkeys on a session with no subagents returns []", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-sub", sessionId: "childless" };
      await store.append(key, [entry()]);
      expect(await store.listSubkeys(key)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("required behavior beyond the 8 named categories", () => {
  test("files are created 0600 and directories 0700", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      await store.append({ projectKey: "proj-perm", sessionId: "s1" }, [entry()]);
      const filePath = join(home, "projects", "proj-perm", "s1.jsonl");
      const dirPath = join(home, "projects", "proj-perm");
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      expect(statSync(dirPath).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, "projects")).mode & 0o777).toBe(0o700);
      expect(statSync(home).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the lock file is created alongside the main jsonl, 0600, holding {pid, startTimeMs}", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      await store.append({ projectKey: "proj-lock", sessionId: "s1" }, [entry()]);
      const lockPath = join(home, "projects", "proj-lock", "s1.lock");
      expect(statSync(lockPath).mode & 0o777).toBe(0o600);
      const lease = JSON.parse(readFileSync(lockPath, "utf8"));
      expect(lease.pid).toBe(process.pid);
      expect(typeof lease.startTimeMs).toBe("number");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects an empty subpath", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      await expect(store.append({ projectKey: "p", sessionId: "s", subpath: "" }, [entry()])).rejects.toThrow(WinterStoreError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects an absolute subpath", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      await expect(store.append({ projectKey: "p", sessionId: "s", subpath: "/etc/passwd" }, [entry()])).rejects.toThrow(WinterStoreError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects a traversal subpath", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      await expect(store.append({ projectKey: "p", sessionId: "s", subpath: "../escape" }, [entry()])).rejects.toThrow(WinterStoreError);
      await expect(
        store.append({ projectKey: "p", sessionId: "s", subpath: "subagents/../../escape" }, [entry()]),
      ).rejects.toThrow(WinterStoreError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects a separator-escaping subpath (double/trailing slash)", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      await expect(store.append({ projectKey: "p", sessionId: "s", subpath: "subagents//agent-a" }, [entry()])).rejects.toThrow(
        WinterStoreError,
      );
      await expect(store.append({ projectKey: "p", sessionId: "s", subpath: "subagents/" }, [entry()])).rejects.toThrow(WinterStoreError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("agent_metadata entries are partitioned out of the jsonl into a sidecar, and load() re-synthesizes the latest one AFTER native entries", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-a", sessionId: "sess-p", subpath: "subagents/agent-meta" };
      const native1 = entry({ type: "assistant_text" });
      const meta1 = { type: "agent_metadata", name: "first-name" };
      const native2 = entry({ type: "assistant_text" });
      const meta2 = { type: "agent_metadata", name: "second-name" }; // latest wins

      await store.append(key, [native1, meta1, native2, meta2]);

      const loaded = await store.load(key);
      expect(loaded).toEqual([native1, native2, meta2]);

      // never appended to the jsonl file itself
      const raw = readFileSync(join(home, "projects", "proj-a", "sess-p", "subagents", "agent-meta.jsonl"), "utf8");
      expect(raw).not.toContain("agent_metadata");

      const metaSidecar = JSON.parse(readFileSync(join(home, "projects", "proj-a", "sess-p", "subagents", "agent-meta.meta.json"), "utf8"));
      expect(metaSidecar).toEqual(meta2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a metadata-only append (no native entries yet) is still readable via load() and enumerable via listSubkeys — a subagent that registers before producing any output", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const parentKey = { projectKey: "proj-a", sessionId: "sess-meta-only" };
      const key = { ...parentKey, subpath: "subagents/agent-early" };
      const meta = { type: "agent_metadata", name: "registered-before-any-output" };

      await store.append(key, [meta]);

      expect(await store.load(key)).toEqual([meta]);
      expect(await store.listSubkeys(parentKey)).toEqual(["subagents/agent-early"]);

      // the jsonl itself must NOT exist — append() never creates one for a metadata-only batch
      const jsonlPath = join(home, "projects", "proj-a", "sess-meta-only", "subagents", "agent-early.jsonl");
      expect(existsSync(jsonlPath)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("listSessionSummaries folds a summary on append, keyed by sessionId, updated across calls", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj-sum", sessionId: "s1" };
      await store.append(key, [entry(), entry()]);
      await store.append(key, [entry()]);

      const summaries = await store.listSessionSummaries("proj-sum");
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.sessionId).toBe("s1");
      expect(summaries[0]!.entryCount).toBe(3);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("winterHome itself is created if missing, owned, and not a symlink (its OWN parent must already exist — same contract as paths/temp.ts's base)", async () => {
    const parent = mkdtempSync(join(tmpdir(), "winter-store-test-parent-"));
    const home = join(parent, ".winter");
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      await store.append({ projectKey: "p", sessionId: "s" }, [entry()]);
      const stat = lstatSync(home);
      expect(stat.isDirectory()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.mode & 0o777).toBe(0o700);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
