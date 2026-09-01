// Task 10: relocated from packages/runtime/src/store/resume.test.ts's own "forkSession" describe
// block when the primitive itself moved to fork-session.ts alongside the store (WS-05 §6). Only
// change from the original: the not-found assertion now checks SessionNotFoundError (this
// package's own typed error) rather than resume.ts's ResumeTargetError, since the relocated
// primitive no longer has access to that runtime-private class -- see fork-session.ts's own
// header comment and task-10-report.md. Every winterHome below is a fresh mkdtemp under the OS
// temp dir — never ~/.winter, ~/.norma, ~/.claude, or a real shared path.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forkSessionByKey } from "./fork-session.ts";
import { WinterCompatibilitySessionStore } from "./session-store.ts";
import { SessionNotFoundError } from "../errors.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "winter-fork-session-test-"));
}

const RFC4122_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("forkSessionByKey", () => {
  test("copies entries into a new session under a fresh lowercase RFC4122 v4 uuid, rewriting each entry's sessionId", async () => {
    const home = freshHome();
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const src = { projectKey: "proj", sessionId: "src-session" };
      await store.append(src, [
        { type: "user", uuid: "u1", parentUuid: null, sessionId: "src-session", message: { role: "user", content: "hi" } },
        { type: "assistant", uuid: "u2", parentUuid: "u1", sessionId: "src-session", message: { role: "assistant", content: "hello" } },
      ]);

      const { sessionId: forkedId } = await forkSessionByKey(store, src);
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

      await forkSessionByKey(store, src);

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
        await forkSessionByKey(store, { projectKey: "proj", sessionId: "never-existed" });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SessionNotFoundError);
      expect((thrown as SessionNotFoundError).reason).toBe("not_found");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
