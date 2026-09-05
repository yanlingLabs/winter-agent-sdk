// Phase 5 Task 7 (Lane K, R5-11 as amended / WS-11 §9): the real FileCheckpointSink -- the
// backup-before-modify store behind `enableFileCheckpointing`.
//
// The seam authority is `checkpoint/seam.contract.test.ts` (the engine owns the interception point
// and the `rewind_files` control request, and drives them against the spine's in-memory fake). What
// is proven here is the store the fake stands in for: where backups live, when a snapshot is taken
// versus a delta recorded, and that a rewind puts the files back.
//
// NO TEST HERE TOUCHES A REAL HOME. Every case builds a `mkdtemp` root and passes it as `home`.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, linkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCheckpointSink, CHECKPOINT_BACKUPS_DIRNAME } from "./sink.ts";
import { checkpointPathHash } from "./file-history.ts";

let home = "";
let work = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "winter-lane-k-ckpt-"));
  work = join(home, "work");
  mkdirSync(work, { recursive: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const sinkFor = (sessionUuid = "sess-1") => createFileCheckpointSink({ home, cwd: work, sessionUuid });
const backupsDir = (sessionUuid = "sess-1") => join(home, CHECKPOINT_BACKUPS_DIRNAME, sessionUuid);
const blobs = (sessionUuid = "sess-1") => readdirSync(backupsDir(sessionUuid)).filter((f) => f.includes("@v")).sort();

describe("checkpoint/file-history.ts -- the backup layout (R5-11 as amended)", () => {
  test("the path hash is the first 16 hex of sha256 of the ABSOLUTE path", () => {
    // DISCLOSED: R5-11 marks the hash algorithm capture-pending and names this as the fallback.
    const abs = join(work, "a.ts");
    expect(checkpointPathHash(abs)).toBe(createHash("sha256").update(abs).digest("hex").slice(0, 16));
    expect(checkpointPathHash(abs)).toHaveLength(16);
    // The hash is over the absolute path, so the same file reached by two spellings is ONE backup.
    expect(checkpointPathHash(abs)).not.toBe(checkpointPathHash(join(work, "b.ts")));
  });

  test("backups live at <home>/backups/<session>/<path-hash>@v<n> -- NOT file-history/<uuid>/", async () => {
    // The R5-11 amendment (derived-shapes-p5 capture (2)): the pinned runtime grew a `backups/`
    // sibling of `projects/`, not the `file-history/<uuid>/` path WS-11 §9's mechanism row assumed.
    writeFileSync(join(work, "a.ts"), "original\n");
    await sinkFor().beforeMutation({ path: join(work, "a.ts"), tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    const expected = `${checkpointPathHash(join(work, "a.ts"))}@v1`;
    expect(existsSync(join(backupsDir(), expected))).toBe(true);
    expect(readFileSync(join(backupsDir(), expected), "utf8")).toBe("original\n");
    expect(existsSync(join(home, "file-history"))).toBe(false);
  });

  test("a RELATIVE candidate path is resolved against cwd before hashing", async () => {
    writeFileSync(join(work, "a.ts"), "original\n");
    await sinkFor().beforeMutation({ path: "a.ts", tool: "Edit", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    expect(existsSync(join(backupsDir(), `${checkpointPathHash(join(work, "a.ts"))}@v1`))).toBe(true);
  });
});

describe("checkpoint/sink.ts -- beforeMutation", () => {
  test("the FIRST mutation of a path in a checkpoint SNAPSHOTS; later ones in the same checkpoint DELTA-RECORD", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, "v0\n");
    const sink = sinkFor();
    await sink.beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    writeFileSync(file, "v1\n"); // the tool ran
    await sink.beforeMutation({ path: file, tool: "Edit", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    writeFileSync(file, "v2\n");
    await sink.beforeMutation({ path: file, tool: "Edit", userMessageUuid: "u-1", sessionUuid: "sess-1" });

    // ONE blob for three mutations: the checkpoint restores to the state at the START of the
    // envelope, so copying the file again mid-envelope would store bytes nothing can ever restore to.
    expect(blobs()).toEqual([`${checkpointPathHash(file)}@v1`]);
    expect(readFileSync(join(backupsDir(), blobs()[0]!), "utf8")).toBe("v0\n");
  });

  test("a NEW checkpoint snapshots again -- one blob per (path, envelope), versioned", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, "v0\n");
    const sink = sinkFor();
    await sink.beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    writeFileSync(file, "v1\n");
    await sink.beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-2", sessionUuid: "sess-1" });
    expect(blobs()).toEqual([`${checkpointPathHash(file)}@v1`, `${checkpointPathHash(file)}@v2`]);
    expect(readFileSync(join(backupsDir(), `${checkpointPathHash(file)}@v2`), "utf8")).toBe("v1\n");
  });

  test("a file that does not exist yet records its ABSENCE rather than a backup of nothing", async () => {
    const file = join(work, "new.ts");
    await sinkFor().beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    // No blob -- there were no bytes. The record still exists, so the rewind knows to DELETE it.
    expect(blobs()).toEqual([]);
    expect(existsSync(join(backupsDir(), "index.jsonl"))).toBe(true);
  });

  test("two sessions under one home never see each other's checkpoints", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, "session one\n");
    await sinkFor("sess-1").beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    writeFileSync(file, "session two\n");
    await sinkFor("sess-2").beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-2" });

    expect(readFileSync(join(backupsDir("sess-1"), blobs("sess-1")[0]!), "utf8")).toBe("session one\n");
    expect(readFileSync(join(backupsDir("sess-2"), blobs("sess-2")[0]!), "utf8")).toBe("session two\n");
    // Session 2's sink cannot rewind session 1's identically-named envelope.
    writeFileSync(file, "current\n");
    const other = await sinkFor("sess-3").rewind("u-1");
    expect(other.canRewind).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("current\n");
  });

  test("the sink writes nothing outside <home>/backups", async () => {
    writeFileSync(join(work, "a.ts"), "x\n");
    await sinkFor().beforeMutation({ path: join(work, "a.ts"), tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    expect(readdirSync(home).sort()).toEqual([CHECKPOINT_BACKUPS_DIRNAME, "work"]);
  });

  test("a backup blob is byte-exact, not utf8-normalised", async () => {
    const file = join(work, "bin.dat");
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x0d, 0x0a, 0x80]);
    writeFileSync(file, bytes);
    await sinkFor().beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    expect(readFileSync(join(backupsDir(), blobs()[0]!)).equals(bytes)).toBe(true);
  });
});

describe("checkpoint/rewind.ts -- rewind", () => {
  test("restores every tracked file to its state at the checkpoint and reports the pinned result", async () => {
    const a = join(work, "a.ts");
    const b = join(work, "b.ts");
    writeFileSync(a, "one\ntwo\n");
    writeFileSync(b, "keep\n");
    const sink = sinkFor();
    await sink.beforeMutation({ path: a, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    writeFileSync(a, "one\ntwo\nthree\nfour\n");
    await sink.beforeMutation({ path: b, tool: "Edit", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    writeFileSync(b, "");

    const result = await sink.rewind("u-1");
    expect(result.canRewind).toBe(true);
    expect(result.filesChanged!.sort()).toEqual([a, b].sort());
    expect(readFileSync(a, "utf8")).toBe("one\ntwo\n");
    expect(readFileSync(b, "utf8")).toBe("keep\n");
    // The rewind ADDED `keep` back to b and REMOVED `three`/`four` from a.
    expect(result.insertions).toBe(1);
    expect(result.deletions).toBe(2);
    expect(result.skippedLinks).toBe(0);
  });

  test("a file CREATED after the checkpoint is deleted by the rewind", async () => {
    const file = join(work, "new.ts");
    const sink = sinkFor();
    await sink.beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    writeFileSync(file, "brand\nnew\n");
    const result = await sink.rewind("u-1");
    expect(existsSync(file)).toBe(false);
    expect(result.filesChanged).toEqual([file]);
    expect(result.deletions).toBe(2);
    expect(result.insertions).toBe(0);
  });

  test("rewinding to an EARLIER checkpoint undoes every envelope after it, oldest state winning", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, "v0\n");
    const sink = sinkFor();
    await sink.beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    writeFileSync(file, "v1\n");
    await sink.beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-2", sessionUuid: "sess-1" });
    writeFileSync(file, "v2\n");
    await sink.beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-3", sessionUuid: "sess-1" });
    writeFileSync(file, "v3\n");

    // Restoring in reverse order lands on the OLDEST snapshot at or after the target.
    expect((await sink.rewind("u-2")).canRewind).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("v1\n");
    expect((await sink.rewind("u-1")).canRewind).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("v0\n");
  });

  test("a file untouched since the checkpoint is NOT reported as changed", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, "same\n");
    const sink = sinkFor();
    await sink.beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    // The tool ran and wrote back identical bytes.
    writeFileSync(file, "same\n");
    const result = await sink.rewind("u-1");
    expect(result.canRewind).toBe(true);
    expect(result.filesChanged).toEqual([]);
    expect(result.insertions).toBe(0);
    expect(result.deletions).toBe(0);
  });

  test("an UNKNOWN id answers canRewind:false with an error -- never a throw", async () => {
    const result = await sinkFor().rewind("never-happened");
    expect(result.canRewind).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error).toContain("never-happened");
    // "Nothing to rewind to" is an ANSWER: the pinned method returns a typed result, so a rejected
    // promise would leave a host unable to tell it from a transport fault.
    expect(result.filesChanged).toBeUndefined();
  });

  test("dryRun computes the SAME counts without touching the filesystem", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, "one\n");
    const sink = sinkFor();
    await sink.beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    writeFileSync(file, "one\ntwo\nthree\n");

    const preview = await sink.rewind("u-1", { dryRun: true });
    expect(preview.canRewind).toBe(true);
    expect(preview.filesChanged).toEqual([file]);
    expect(preview.deletions).toBe(2);
    expect(preview.insertions).toBe(0);
    // Item (e): `skippedLinks` is populated on REAL rewinds only, so a preview's counts do not
    // reflect refusals -- and the field is absent rather than a misleading zero.
    expect("skippedLinks" in preview).toBe(false);
    // The file is exactly as it was.
    expect(readFileSync(file, "utf8")).toBe("one\ntwo\nthree\n");

    const real = await sink.rewind("u-1");
    expect(real.filesChanged).toEqual(preview.filesChanged);
    expect(real.deletions).toBe(preview.deletions);
    expect(readFileSync(file, "utf8")).toBe("one\n");
  });

  test("a dryRun does not promise a change a real rewind would refuse -- a MISSING backup blob", async () => {
    // A real rewind refuses a snapshot whose blob cannot be read (`skippedLinks`), so a preview that
    // reported the file as about-to-be-deleted would be describing a plan that can never run. This
    // is NOT the "previews do not reflect refusals" case item (e) sanctions: that is about the
    // USER's tree changing under a valid plan, this is a corrupt store with nothing to restore FROM.
    const file = join(work, "a.ts");
    writeFileSync(file, "original\n");
    const sink = sinkFor();
    await sink.beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    writeFileSync(file, "changed\nand grew\n");
    rmSync(join(backupsDir(), blobs()[0]!)); // the blob is gone

    const preview = await sink.rewind("u-1", { dryRun: true });
    expect(preview.canRewind).toBe(true);
    expect(preview.filesChanged).toEqual([]);
    expect(preview.deletions).toBe(0);

    const real = await sink.rewind("u-1");
    expect(real.skippedLinks).toBe(1);
    expect(real.filesChanged).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("changed\nand grew\n");
  });

  test("a dryRun on a session with no checkpoints at all creates no backups directory", async () => {
    const result = await createFileCheckpointSink({ home, cwd: work, sessionUuid: "untouched" }).rewind("u-1", { dryRun: true });
    expect(result.canRewind).toBe(false);
    expect(existsSync(join(home, CHECKPOINT_BACKUPS_DIRNAME, "untouched"))).toBe(false);
  });
});

describe("checkpoint/rewind.ts -- link safety (item (e)'s behavioural rule)", () => {
  test("a tracked path that is now a SYMLINK is refused, not followed", async () => {
    const file = join(work, "a.ts");
    const target = join(work, "elsewhere.ts");
    writeFileSync(file, "original\n");
    writeFileSync(target, "someone else's file\n");
    const sink = sinkFor();
    await sink.beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    // Between the checkpoint and the rewind the path became a link into another file. Restoring
    // through it would silently overwrite a file the checkpoint never backed up.
    rmSync(file);
    symlinkSync(target, file);

    const result = await sink.rewind("u-1");
    expect(result.canRewind).toBe(true);
    expect(result.skippedLinks).toBe(1);
    expect(result.filesChanged).toEqual([]);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("someone else's file\n");
  });

  test("a tracked path that gained a HARD LINK is refused", async () => {
    const file = join(work, "a.ts");
    writeFileSync(file, "original\n");
    const sink = sinkFor();
    await sink.beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    writeFileSync(file, "changed\n");
    linkSync(file, join(work, "hard-link.ts"));

    const result = await sink.rewind("u-1");
    expect(result.skippedLinks).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("changed\n");
  });

  test("a path whose PARENT no longer resolves where it did is refused", async () => {
    const dir = join(work, "pkg");
    mkdirSync(dir);
    const file = join(dir, "a.ts");
    writeFileSync(file, "original\n");
    const sink = sinkFor();
    await sink.beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    writeFileSync(file, "changed\n");
    // The directory the checkpoint recorded is gone; `pkg` is now a link somewhere else entirely.
    const decoy = join(work, "decoy");
    mkdirSync(decoy);
    rmSync(dir, { recursive: true, force: true });
    symlinkSync(decoy, dir);
    writeFileSync(join(decoy, "a.ts"), "a different a.ts\n");

    const result = await sink.rewind("u-1");
    expect(result.skippedLinks).toBe(1);
    expect(readFileSync(join(decoy, "a.ts"), "utf8")).toBe("a different a.ts\n");
  });

  test("a checkpoint whose PARENT DID NOT EXIST cannot delete a stranger's file through a swapped ancestor", async () => {
    // THE M1 HOLE. A `Write` to a path whose parent the tool is about to create records
    // `absent: true` -- and `absent: true` is exactly the record the rewind services with `rmSync`.
    // The old parent guard was applied only when a parent real path had been recorded, which is
    // precisely what a non-existent parent cannot produce, so the DELETE arm ran with no path-
    // identity check at all. Swapping the directory for a link then deleted a file this session had
    // never touched.
    const newdir = join(work, "newdir");
    const target = join(newdir, "x.ts");
    const outside = join(home, "outside");
    mkdirSync(outside);
    const victim = join(outside, "x.ts");
    writeFileSync(victim, "a file this session never touched\n");

    const sink = sinkFor();
    await sink.beforeMutation({ path: target, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    mkdirSync(newdir);
    writeFileSync(target, "created by the model\n");

    // Later, something outside the tracked set (Bash, or another program) swaps the directory.
    rmSync(target);
    rmSync(newdir, { recursive: true, force: true });
    symlinkSync(outside, newdir);

    // The PREVIEW must not promise the deletion either: a path-identity refusal means the plan is
    // not about the intended file at all, so listing it would be a wrong path in `filesChanged`
    // rather than a count that merely does not reflect a refusal.
    const preview = await sink.rewind("u-1", { dryRun: true });
    expect(preview.canRewind).toBe(true);
    expect(preview.filesChanged).toEqual([]);
    expect("skippedLinks" in preview).toBe(false);

    const result = await sink.rewind("u-1");
    expect(result.canRewind).toBe(true);
    expect(result.skippedLinks).toBe(1);
    expect(result.filesChanged).toEqual([]);
    expect(existsSync(victim)).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("a file this session never touched\n");
  });

  test("an absent-parent checkpoint whose ANCHOR directory itself moved is refused", async () => {
    // The other half of the same guard: the nearest ancestor that DID exist at checkpoint time is
    // itself no longer the same directory.
    const newdir = join(work, "newdir");
    const target = join(newdir, "x.ts");
    const sink = sinkFor();
    await sink.beforeMutation({ path: target, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    mkdirSync(newdir);
    writeFileSync(target, "created by the model\n");

    // `work` -- the anchor -- is swapped for a link to a tree that happens to have the same shape.
    const decoy = join(home, "decoy");
    mkdirSync(join(decoy, "newdir"), { recursive: true });
    const victim = join(decoy, "newdir", "x.ts");
    writeFileSync(victim, "someone else's x.ts\n");
    rmSync(work, { recursive: true, force: true });
    symlinkSync(decoy, work);

    const result = await sink.rewind("u-1");
    expect(result.skippedLinks).toBe(1);
    expect(existsSync(victim)).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("someone else's x.ts\n");
  });

  test("an INTERMEDIATE component that became a symlink is refused, not only the immediate parent", async () => {
    const a = join(work, "a");
    const b = join(a, "b");
    mkdirSync(b, { recursive: true });
    const file = join(b, "f.ts");
    writeFileSync(file, "original\n");
    const sink = sinkFor();
    await sink.beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    writeFileSync(file, "changed\n");

    const decoy = join(home, "decoy");
    mkdirSync(join(decoy, "b"), { recursive: true });
    const victim = join(decoy, "b", "f.ts");
    writeFileSync(victim, "someone else's f.ts\n");
    rmSync(a, { recursive: true, force: true });
    symlinkSync(decoy, a); // two levels above the file, not its immediate parent

    const result = await sink.rewind("u-1");
    expect(result.skippedLinks).toBe(1);
    expect(readFileSync(victim, "utf8")).toBe("someone else's f.ts\n");
  });

  test("a refusal never stops the rewind of the OTHER files", async () => {
    const linked = join(work, "linked.ts");
    const plain = join(work, "plain.ts");
    writeFileSync(linked, "linked original\n");
    writeFileSync(plain, "plain original\n");
    const sink = sinkFor();
    await sink.beforeMutation({ path: linked, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    await sink.beforeMutation({ path: plain, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    writeFileSync(plain, "plain changed\n");
    rmSync(linked);
    symlinkSync(join(work, "target.ts"), linked);

    const result = await sink.rewind("u-1");
    expect(result.skippedLinks).toBe(1);
    expect(result.filesChanged).toEqual([plain]);
    expect(readFileSync(plain, "utf8")).toBe("plain original\n");
  });
});

describe("checkpoint -- the SCOPE boundary: Bash and subagent changes (WS-11 §9)", () => {
  test("a mixed Write/Bash sequence rewinds the Write and leaves the Bash-created file alone", async () => {
    const tracked = join(work, "tracked.ts");
    const byBash = join(work, "made-by-bash.txt");
    writeFileSync(tracked, "before the write\n");
    const sink = sinkFor();

    // 1. A `Write` -- announced to the sink by the engine, so it is checkpointed.
    await sink.beforeMutation({ path: tracked, tool: "Write", userMessageUuid: "u-1", sessionUuid: "sess-1" });
    writeFileSync(tracked, "after the write\n");
    // 2. A `Bash` round -- `isCheckpointedTool("Bash")` is false, so the sink is NEVER called. Its
    //    effects are simulated directly here, on BOTH a new file and the tracked one.
    writeFileSync(byBash, "bash made this\n");
    writeFileSync(tracked, "after the write\nand then bash appended\n");

    const result = await sink.rewind("u-1");
    expect(result.canRewind).toBe(true);
    // The TRACKED path goes back to its checkpoint state -- a rewind restores PATHS, not authorship,
    // so Bash's edit to a tracked file is undone as collateral. That is the honest reading of
    // "backup-before-modify on the three mutating tools".
    expect(readFileSync(tracked, "utf8")).toBe("before the write\n");
    // The Bash-CREATED file was never checkpointed: untouched, and absent from the report. This is
    // the pinned scope boundary, not an oversight -- pretending otherwise would produce a rewind
    // that silently half-restores.
    expect(existsSync(byBash)).toBe(true);
    expect(readFileSync(byBash, "utf8")).toBe("bash made this\n");
    expect(result.filesChanged).toEqual([tracked]);
  });

  test("a SUBAGENT's edits are untouched -- they are its own session's checkpoints, not the parent's", async () => {
    const file = join(work, "shared.ts");
    writeFileSync(file, "parent state\n");
    const parent = sinkFor("parent-session");
    await parent.beforeMutation({ path: file, tool: "Write", userMessageUuid: "u-1", sessionUuid: "parent-session" });
    writeFileSync(file, "parent wrote\n");

    // The child runs under its own session id, so its checkpoint lands in its own subtree.
    const child = createFileCheckpointSink({ home, cwd: work, sessionUuid: "child-session" });
    await child.beforeMutation({ path: file, tool: "Edit", userMessageUuid: "child-u-1", sessionUuid: "child-session" });
    writeFileSync(file, "child wrote\n");

    // The parent rewinding its own envelope cannot see the child's envelope at all.
    expect((await parent.rewind("child-u-1")).canRewind).toBe(false);
    expect((await parent.rewind("u-1")).canRewind).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("parent state\n");
  });
});
