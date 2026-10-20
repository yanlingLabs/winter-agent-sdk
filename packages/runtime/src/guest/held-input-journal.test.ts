import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELD_INPUT_MAX_RECORDS, HELD_INPUT_MAX_TEXT_BYTES, HeldInputError, heldInputDigest, heldInputJournalPath, openHeldInputJournal, realHeldInputIo, type HeldInputIo, type HeldInputJournal } from "./held-input-journal.ts";

const roots: string[] = [];
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), "winter-journal-")); roots.push(d); return d; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const T = (n: number): string => n.toString(16).padStart(64, "0");
const hold = (journal: HeldInputJournal, id = "r1", token = T(1), text = "body", clientName = "peer") => journal.hold({ inputId: id, holdToken: token, text, clientName });
const code = (fn: () => unknown): string | undefined => { try { fn(); } catch (error) { return error instanceof HeldInputError ? error.code : `other:${String(error)}`; } return undefined; };
const open = (directory = temp()) => { const path = join(directory, "projects", "key", "sess", "held-inputs.json"); return { path, ...openHeldInputJournal(path) }; };
const onDisk = (path: string) => JSON.parse(readFileSync(path, "utf8")).records;

test("hold writes a durable held record; the same body again replaces the token; another body is a conflict", () => {
  const { journal, path } = open();
  expect(hold(journal)).toEqual({ held: true });
  expect(onDisk(path)).toEqual([{ inputId: "r1", digest: heldInputDigest("body", "peer"), holdToken: T(1), state: "held", text: "body", clientName: "peer" }]);
  expect(hold(journal, "r1", T(2))).toEqual({ held: true, again: true });
  expect(onDisk(path)[0].holdToken).toBe(T(2));
  expect(code(() => hold(journal, "r1", T(3), "another body"))).toBe("conflict");
  expect(onDisk(path)[0]).toMatchObject({ holdToken: T(2), text: "body" });
  expect(code(() => hold(journal, "r1", T(3), "body", "other client"))).toBe("conflict");
});

test("commit: held+token commits durably; the same token again is already; another token is superseded; no record is unknown_input", () => {
  const { journal, path } = open();
  hold(journal);
  expect(code(() => journal.commit("r1", T(9)))).toBe("superseded");
  expect(onDisk(path)[0].state).toBe("held");
  const result = journal.commit("r1", T(1));
  expect(result).toMatchObject({ kind: "committed", record: { inputId: "r1", text: "body", state: "committed" } });
  expect(onDisk(path)[0].state).toBe("committed");
  expect(journal.commit("r1", T(1))).toEqual({ kind: "already" });
  // Committed and in_transcript records answer `already` whatever the token (a re-hold answered {held:false} was acked under a NEW token).
  expect(journal.commit("r1", T(9))).toEqual({ kind: "already" });
  journal.markInTranscript("r1");
  expect(journal.commit("r1", T(1))).toEqual({ kind: "already" });
  expect(journal.commit("r1", T(9))).toEqual({ kind: "already" });
  expect(code(() => journal.commit("ghost", T(1)))).toBe("unknown_input");
});

test("discard: held+token deletes; unknown is idempotent; another token is superseded and changes nothing; committed and in_transcript refuse", () => {
  const { journal, path } = open();
  expect(journal.discard("ghost", T(1))).toEqual({ discarded: true });
  hold(journal);
  expect(journal.discard("r1", T(9))).toEqual({ discarded: false, reason: "superseded" });
  expect(onDisk(path)).toHaveLength(1);
  expect(journal.discard("r1", T(1))).toEqual({ discarded: true });
  expect(onDisk(path)).toEqual([]);
  hold(journal, "r2");
  journal.commit("r2", T(1));
  expect(code(() => journal.discard("r2", T(1)))).toBe("committed");
  expect(code(() => journal.discard("r2", T(9)))).toBe("committed");
  journal.markInTranscript("r2");
  expect(code(() => journal.discard("r2", T(1)))).toBe("committed");
});

test("forget deletes only an in_transcript tombstone with its token; everything else reports forgotten:false; unknown is idempotent", () => {
  const { journal, path } = open();
  expect(journal.forget("ghost", T(1))).toEqual({ forgotten: true });
  hold(journal);
  expect(journal.forget("r1", T(1))).toEqual({ forgotten: false });
  journal.commit("r1", T(1));
  expect(journal.forget("r1", T(1))).toEqual({ forgotten: false });
  journal.markInTranscript("r1");
  expect(journal.forget("r1", T(9))).toEqual({ forgotten: false });
  expect(onDisk(path)).toHaveLength(1);
  expect(journal.forget("r1", T(1))).toEqual({ forgotten: true });
  expect(onDisk(path)).toEqual([]);
});

test("markInTranscript turns a committed record into a body-less tombstone, is idempotent, and never touches a held or missing record", () => {
  const { journal, path } = open();
  hold(journal);
  journal.markInTranscript("r1");
  expect(onDisk(path)[0].state).toBe("held");
  journal.commit("r1", T(1));
  journal.markInTranscript("r1");
  journal.markInTranscript("r1");
  journal.markInTranscript("ghost");
  expect(onDisk(path)).toEqual([{ inputId: "r1", digest: heldInputDigest("body", "peer"), holdToken: T(1), state: "in_transcript" }]);
});

test("a hold on a committed or in_transcript input answers held:false with its state and writes nothing", () => {
  const { journal, path } = open();
  hold(journal);
  journal.commit("r1", T(1));
  const before = readFileSync(path, "utf8");
  expect(hold(journal, "r1", T(2))).toEqual({ held: false, state: "committed" });
  journal.markInTranscript("r1");
  expect(hold(journal, "r1", T(2))).toEqual({ held: false, state: "in_transcript" });
  expect(readFileSync(path, "utf8")).not.toBe(before);          // the tombstone write
  expect(onDisk(path)[0].holdToken).toBe(T(1));
});

test("restart dedupe: held and committed records the transcript holds become in_transcript; the rest are untouched; the result names who moved", () => {
  const { journal, path } = open();
  hold(journal, "held-in-t"); hold(journal, "held-not"); hold(journal, "committed-in-t"); hold(journal, "committed-not");
  journal.commit("committed-in-t", T(1)); journal.commit("committed-not", T(1));
  expect(journal.dedupe(new Set(["held-in-t", "committed-in-t", "unrelated"])).sort()).toEqual(["committed-in-t", "held-in-t"]);
  expect(Object.fromEntries(onDisk(path).map((r: any) => [r.inputId, r.state]))).toEqual({ "held-in-t": "in_transcript", "held-not": "held", "committed-in-t": "in_transcript", "committed-not": "committed" });
  expect(journal.dedupe(new Set(["held-in-t"]))).toEqual([]);
  expect(onDisk(path).find((r: any) => r.inputId === "held-in-t").text).toBeUndefined();
});

test("a reopened journal is exactly what was durable; list() hands out copies", () => {
  const { journal, path } = open();
  hold(journal, "a"); hold(journal, "b"); journal.commit("b", T(1));
  const reopened = openHeldInputJournal(path).journal;
  expect(reopened.list()).toEqual(journal.list());
  journal.list()[0]!.state = "committed";
  expect(journal.list()[0]!.state).toBe("held");
});

test("every change is atomic: a failing durable write leaves memory and disk unchanged, for each verb", () => {
  const directory = temp();
  const path = join(directory, "held-inputs.json");
  let failing = false;
  const io: HeldInputIo = { read: realHeldInputIo.read, write(p, data) { if (failing) throw new Error("disk full"); realHeldInputIo.write(p, data); } };
  const { journal } = openHeldInputJournal(path, io);
  hold(journal, "r1"); hold(journal, "r2"); journal.commit("r2", T(1));
  const snapshot = readFileSync(path, "utf8"), list = JSON.stringify(journal.list());
  failing = true;
  for (const [name, action] of [
    ["new hold", () => hold(journal, "r3")], ["re-hold", () => hold(journal, "r1", T(2))], ["commit", () => journal.commit("r1", T(1))],
    ["discard", () => journal.discard("r1", T(1))], ["mark", () => journal.markInTranscript("r2")], ["dedupe", () => journal.dedupe(new Set(["r1"]))],
  ] as const) {
    expect(code(action), name).toBe("journal_failed");
    expect(JSON.stringify(journal.list()), name).toBe(list);
    expect(readFileSync(path, "utf8"), name).toBe(snapshot);
  }
  failing = false;
  expect(journal.commit("r1", T(1))).toMatchObject({ kind: "committed" });   // and it works once the disk does
});

test("the real write is temp file, fsync, rename and directory fsync: no temp file is left behind and the file is private", () => {
  const { journal, path } = open();
  hold(journal);
  const directory = join(path, "..");
  expect(readdirSync(directory)).toEqual(["held-inputs.json"]);
  expect(realHeldInputIo.read(path)).toContain('"inputId":"r1"');
  const mode = require("node:fs").statSync(path).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("a torn or foreign file is moved aside, never trusted and never silently overwritten", () => {
  const directory = temp();
  const path = join(directory, "held-inputs.json");
  for (const raw of ["{ torn", "[]", JSON.stringify({ version: 2, records: [] }), JSON.stringify({ version: 1, records: [{ inputId: "r1" }] }),
    JSON.stringify({ version: 1, records: [{ inputId: "r1", digest: T(1), holdToken: T(1), state: "wrong", text: "x", clientName: "p" }] }),
    JSON.stringify({ version: 1, records: [{ inputId: "r1", digest: T(1), holdToken: "nothex", state: "held", text: "x", clientName: "p" }] }),
    JSON.stringify({ version: 1, records: [{ inputId: "r1", digest: T(1), holdToken: T(1), state: "held" }] }),
    JSON.stringify({ version: 1, records: [{ inputId: "r1", digest: T(1), holdToken: T(1), state: "held", text: "x", clientName: "p" }, { inputId: "r1", digest: T(1), holdToken: T(1), state: "held", text: "x", clientName: "p" }] })]) {
    writeFileSync(path, raw);
    const opened = openHeldInputJournal(path);
    expect(opened.quarantined, raw).toBeDefined();
    expect(readFileSync(opened.quarantined!, "utf8")).toBe(raw);
    expect(opened.journal.list()).toEqual([]);
    expect(onDisk(path)).toEqual([]);
    rmSync(opened.quarantined!);
  }
});

test("a journal file with more records than the cap is not trusted", () => {
  const directory = temp();
  const path = join(directory, "held-inputs.json");
  const record = (i: number) => ({ inputId: `id-${i}`, digest: T(1), holdToken: T(1), state: "held", text: "x", clientName: "p" });
  writeFileSync(path, JSON.stringify({ version: 1, records: Array.from({ length: HELD_INPUT_MAX_RECORDS }, (_, i) => record(i)) }));
  expect(openHeldInputJournal(path).quarantined).toBeUndefined();
  writeFileSync(path, JSON.stringify({ version: 1, records: Array.from({ length: HELD_INPUT_MAX_RECORDS + 1 }, (_, i) => record(i)) }));
  expect(openHeldInputJournal(path).quarantined).toBeDefined();
});

test("invalid ids, tokens, bodies and client names are refused before anything is written; the table is capped", () => {
  const { journal, path } = open();
  for (const [name, request] of [
    ["empty id", { inputId: "", holdToken: T(1), text: "x", clientName: "p" }], ["space id", { inputId: "a b", holdToken: T(1), text: "x", clientName: "p" }],
    ["long id", { inputId: "a".repeat(129), holdToken: T(1), text: "x", clientName: "p" }], ["short token", { inputId: "a", holdToken: "ab", text: "x", clientName: "p" }],
    ["upper token", { inputId: "a", holdToken: "A".repeat(64), text: "x", clientName: "p" }], ["empty text", { inputId: "a", holdToken: T(1), text: "", clientName: "p" }],
    ["huge text", { inputId: "a", holdToken: T(1), text: "x".repeat(HELD_INPUT_MAX_TEXT_BYTES + 1), clientName: "p" }], ["long client", { inputId: "a", holdToken: T(1), text: "x", clientName: "p".repeat(257) }],
    ["number text", { inputId: "a", holdToken: T(1), text: 1, clientName: "p" }],
  ] as const) expect(code(() => journal.hold(request as never)), name).toBe("invalid");
  expect(code(() => journal.commit("a", "x"))).toBe("invalid");
  expect(code(() => journal.discard(1 as never, T(1)))).toBe("invalid");
  expect(code(() => journal.forget("a", 5 as never))).toBe("invalid");
  expect(existsSync(path)).toBe(false);
  expect(hold(journal, "a", T(1), "x".repeat(HELD_INPUT_MAX_TEXT_BYTES))).toEqual({ held: true });
  for (let i = 1; i < HELD_INPUT_MAX_RECORDS; i++) hold(journal, `id-${i}`);
  expect(code(() => hold(journal, "overflow"))).toBe("journal_full");
  expect(hold(journal, "a", T(2), "x".repeat(HELD_INPUT_MAX_TEXT_BYTES))).toEqual({ held: true, again: true });   // an existing id is never refused by the cap
});

test("the journal lives beside the transcript, keyed by session", () => {
  expect(heldInputJournalPath("/store", "proj", "sess")).toBe("/store/projects/proj/sess/held-inputs.json");
});

test("the durable write is temp file -> fsync(file) -> rename -> fsync(directory), in that order, and the journal never writes the file in place", () => {
  const source = readFileSync(new URL("./held-input-journal.ts", import.meta.url), "utf8");
  const write = source.slice(source.indexOf("write(path, data) {"), source.indexOf("export function heldInputDigest"));
  const order = ["O_EXCL | fsConstants.O_NOFOLLOW", "fsyncSync(fd)", "closeSync(fd)", "renameSync(temp, path)", "fsyncSync(dir)"].map(token => write.indexOf(token));
  expect(order.every(index => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(write.match(/fsyncSync\(/g)).toHaveLength(2);
  expect(write).not.toContain("writeFileSync");
});

test("a body that begins with a slash is invalid, after any leading whitespace: a committed input is a user turn, never a command", () => {
  const { journal } = open();
  for (const text of ["/compact keep nothing", "  /clear", "\n\t/x", "\u00a0/compact"]) {
    expect(code(() => journal.hold({ inputId: "s1", holdToken: T(1), text, clientName: "peer" })), JSON.stringify(text)).toBe("invalid");
  }
  expect(journal.list()).toEqual([]);
  for (const [index, text] of ["a/b", "hello /compact", "1/2"].entries()) expect(journal.hold({ inputId: `ok-${index}`, holdToken: T(1), text, clientName: "peer" })).toEqual({ held: true });
});

test("the same id with another body is a conflict in every state, by the digest the record keeps; the same body still answers by state", () => {
  const { journal, path } = open();
  hold(journal);
  expect(code(() => hold(journal, "r1", T(2), "another body"))).toBe("conflict");               // held
  expect(code(() => hold(journal, "r1", T(2), "body", "other client"))).toBe("conflict");       // the client name is part of the digest
  journal.commit("r1", T(1));
  expect(code(() => hold(journal, "r1", T(2), "another body"))).toBe("conflict");               // committed
  journal.markInTranscript("r1");
  const before = readFileSync(path, "utf8");
  expect(code(() => hold(journal, "r1", T(2), "another body"))).toBe("conflict");               // in_transcript (a tombstone keeps its digest)
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(hold(journal, "r1", T(2))).toEqual({ held: false, state: "in_transcript" });
});
