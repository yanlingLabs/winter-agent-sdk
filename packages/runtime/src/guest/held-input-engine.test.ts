import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { EPOCH, gate, journalRecords, sleep, startGuest, tempRoot, tokenOf, transcriptLinesFor, type Guest } from "./held-input-harness.ts";

const open: Guest[] = [];
const roots: string[] = [];
function guest(options: Parameters<typeof startGuest>[0]): Guest {
  const g = startGuest(options);
  open.push(g);
  return g;
}
afterEach(async () => {
  for (const g of open.splice(0)) { try { g.send({ type: "control_request", requestId: "fin", subtype: "end_input" }); g.proc.stdin.end(); await Promise.race([g.proc.exited, sleep(150)]); } catch { /* already gone */ } g.kill(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fresh = (label: string) => { const t = tempRoot(label); roots.push(dirname(t.home)); return t; };

test("a guest run always emits system/held_inputs exactly once, empty when nothing is held, before any input is read", async () => {
  const { home, cwd } = fresh("empty");
  const g = guest({ home, cwd });
  const held = await g.waitFor(() => g.system("held_inputs")[0], "system/held_inputs");
  expect(held.inputs).toEqual([]);
  const order = g.frames.map(f => f.type);
  expect(order.indexOf("init")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("init")).toBeLessThan(g.frames.findIndex(f => (f as any).message?.subtype === "held_inputs"));
  g.send({ type: "user", text: "hello" });
  await g.waitFor(() => g.results()[0], "the first result");
  expect(g.system("held_inputs")).toHaveLength(1);
});

// --- hold / commit / discard / forget, one verb at a time --------------------------------------------------

test("hold is durable and invisible to the model: no turn starts, the journal carries the record, and held_inputs is not re-emitted", async () => {
  const { home, cwd } = fresh("hold");
  const g = guest({ home, cwd });
  await g.waitFor(() => g.system("held_inputs")[0], "held_inputs");
  const answer = await g.hold("r1", "a");
  expect(answer).toMatchObject({ ok: true, payload: { held: true } });
  expect(answer.payload.again).toBeUndefined();
  await sleep(150);
  expect(g.requests).toHaveLength(0);
  expect(g.results()).toHaveLength(0);
  expect(journalRecords(home)).toMatchObject([{ inputId: "r1", state: "held", holdToken: tokenOf("a"), text: "message r1", clientName: "peer" }]);
});

test("the same input held again replaces the token; a verdict for the earlier hold is superseded and changes nothing", async () => {
  const { home, cwd } = fresh("rehold");
  const g = guest({ home, cwd });
  await g.hold("r1", "a");
  expect(await g.hold("r1", "b")).toMatchObject({ ok: true, payload: { held: true, again: true } });
  expect(journalRecords(home)[0]).toMatchObject({ holdToken: tokenOf("b"), state: "held" });
  expect(await g.commit("r1", "a")).toMatchObject({ ok: false, error: { code: "superseded" } });
  expect(await g.discard("r1", "a")).toMatchObject({ ok: true, payload: { discarded: false, reason: "superseded" } });
  expect(journalRecords(home)[0]).toMatchObject({ holdToken: tokenOf("b"), state: "held" });
  expect(g.requests).toHaveLength(0);
  expect(await g.commit("r1", "b")).toMatchObject({ ok: true, payload: { outcome: "started" } });
});

test("the same id with another body is a conflict and writes nothing", async () => {
  const { home, cwd } = fresh("conflict");
  const g = guest({ home, cwd });
  await g.hold("r1", "a", "first body");
  expect(await g.control("host_input_hold", { inputId: "r1", holdToken: tokenOf("b"), epoch: EPOCH, text: "another body", clientName: "peer" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(journalRecords(home)[0]).toMatchObject({ holdToken: tokenOf("a"), text: "first body" });
});

test("commit on an idle runtime starts a turn, appends the tagged transcript entry, marks the journal in_transcript, and a repeat is `already`", async () => {
  const { home, cwd } = fresh("commit");
  const g = guest({ home, cwd });
  await g.hold("r1", "a", "hello from a peer");
  const answer = await g.commit("r1", "a");
  expect(answer).toMatchObject({ ok: true, payload: { outcome: "started" } });
  expect(g.system("host_input_committed")).toMatchObject([{ inputId: "r1", outcome: "started" }]);
  await g.waitFor(() => g.results()[0], "the turn's result");
  expect(g.texts().join("")).toContain("hello from a peer");
  const lines = transcriptLinesFor(home, "r1");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ type: "user", origin: { kind: "host-input", inputId: "r1" } });
  await g.waitFor(() => journalRecords(home)[0]?.state === "in_transcript" ? true : undefined, "journal in_transcript");
  expect(journalRecords(home)[0]!.text).toBeUndefined();
  expect(await g.commit("r1", "a")).toMatchObject({ ok: true, payload: { outcome: "already" } });
  expect(await g.commit("r1", "other")).toMatchObject({ ok: true, payload: { outcome: "already" } });   // whatever the token once it is part of the conversation
  expect(g.requests.length).toBe(1);
});

test("forget deletes only an in_transcript tombstone with its token, is idempotent, and a late commit is answered from the transcript, not unknown_input", async () => {
  const { home, cwd } = fresh("forget");
  const g = guest({ home, cwd });
  await g.hold("r1", "a");
  expect(await g.forget("r1", "a")).toMatchObject({ ok: true, payload: { forgotten: false } });   // still held: not eligible
  await g.commit("r1", "a");
  await g.waitFor(() => journalRecords(home)[0]?.state === "in_transcript" ? true : undefined, "journal in_transcript");
  expect(await g.forget("r1", "wrong")).toMatchObject({ ok: true, payload: { forgotten: false } });
  expect(journalRecords(home)).toHaveLength(1);
  expect(await g.forget("r1", "a")).toMatchObject({ ok: true, payload: { forgotten: true } });
  expect(journalRecords(home)).toEqual([]);
  expect(await g.forget("r1", "a")).toMatchObject({ ok: true, payload: { forgotten: true } });
  // the transcript still holds it: a late commit is `already`, never a terminal unknown_input
  expect(await g.commit("r1", "a")).toMatchObject({ ok: true, payload: { outcome: "already" } });
  expect(await g.commit("never-seen", "a")).toMatchObject({ ok: false, error: { code: "unknown_input" } });
});

test("discard deletes a held record, is idempotent for an unknown id, and refuses once the input is committed", async () => {
  const { home, cwd } = fresh("discard");
  const g = guest({ home, cwd });
  expect(await g.discard("ghost", "a")).toMatchObject({ ok: true, payload: { discarded: true } });
  await g.hold("r1", "a");
  expect(await g.discard("r1", "a")).toMatchObject({ ok: true, payload: { discarded: true } });
  expect(journalRecords(home)).toEqual([]);
  await g.hold("r2", "a");
  await g.commit("r2", "a");
  expect(await g.discard("r2", "a")).toMatchObject({ ok: false, error: { code: "committed" } });
  await g.waitFor(() => journalRecords(home)[0]?.state === "in_transcript" ? true : undefined, "journal in_transcript");
  expect(await g.discard("r2", "a")).toMatchObject({ ok: false, error: { code: "committed" } });
});

test("a hold on an already committed or in_transcript input answers held:false and changes nothing", async () => {
  const { home, cwd } = fresh("heldfalse");
  const g = guest({ home, cwd, toolGate: gate(), script: (_r, call) => (call === 0 ? { tool: true } : { text: "ok" }) });
  g.send({ type: "user", text: "start a turn that stays running" });
  await g.waitFor(() => g.toolRuns.length > 0 ? true : undefined, "the tool call");
  await g.hold("r1", "a");
  expect(await g.commit("r1", "a")).toMatchObject({ ok: true, payload: { outcome: "folded" } });
  expect(await g.hold("r1", "b")).toMatchObject({ ok: true, payload: { held: false, state: "committed" } });
  expect(journalRecords(home)[0]).toMatchObject({ state: "committed", holdToken: tokenOf("a") });
});

test("commit for an input with no record anywhere is the terminal unknown_input, and a hold for another epoch or a malformed payload is refused without a write", async () => {
  const { home, cwd } = fresh("errors");
  const g = guest({ home, cwd });
  expect(await g.commit("ghost", "a")).toMatchObject({ ok: false, error: { code: "unknown_input" } });
  expect(await g.commit("ghost", "a")).toMatchObject({ ok: false, error: { code: "unknown_input" } });
  expect(await g.hold("r1", "a", "x", { incarnationId: "inc-2", leaseEpoch: 1 })).toMatchObject({ ok: false, error: { code: "epoch" } });
  expect(await g.hold("r1", "a", "x", { incarnationId: "inc-1", leaseEpoch: 2 })).toMatchObject({ ok: false, error: { code: "epoch" } });
  expect(await g.control("host_input_hold", { inputId: "r1", holdToken: tokenOf("a"), epoch: EPOCH, text: "x" })).toMatchObject({ ok: false, error: { code: "invalid" } });
  expect(await g.control("host_input_hold", { inputId: "r1", holdToken: tokenOf("a"), epoch: { ...EPOCH, extra: 1 }, text: "x", clientName: "p" })).toMatchObject({ ok: false, error: { code: "invalid" } });
  expect(await g.control("host_input_hold", { inputId: "r1", holdToken: tokenOf("a"), epoch: EPOCH, text: "x", clientName: "p", extra: 1 })).toMatchObject({ ok: false, error: { code: "invalid" } });
  expect(await g.control("host_input_commit", { inputId: "r1" })).toMatchObject({ ok: false, error: { code: "invalid" } });
  expect(await g.control("host_input_commit", { inputId: "r1", holdToken: "short" })).toMatchObject({ ok: false, error: { code: "invalid" } });
  expect(await g.control("host_input_discard", { inputId: "bad id", holdToken: tokenOf("a") })).toMatchObject({ ok: false, error: { code: "invalid" } });
  expect(await g.control("host_input_forget", { inputId: "r1", holdToken: tokenOf("a"), more: 1 })).toMatchObject({ ok: false, error: { code: "invalid" } });
  expect(journalRecords(home)).toEqual([]);
});

// --- where a committed input enters the conversation ----------------------------------------------------------

test("a commit during a running turn FOLDS into it at the next tool boundary: the model sees it in the next request, one result, a tagged attachment in the transcript", async () => {
  const { home, cwd } = fresh("fold");
  const toolGate = gate();
  const g = guest({ home, cwd, toolGate, script: (_r, call) => (call === 0 ? { tool: true } : { text: "done" }) });
  g.send({ type: "user", text: "work on something" });
  await g.waitFor(() => g.toolRuns.length > 0 ? true : undefined, "the tool call");
  await g.hold("r1", "a", "peer says hi");
  expect(await g.commit("r1", "a")).toMatchObject({ ok: true, payload: { outcome: "folded" } });
  expect(journalRecords(home)[0]).toMatchObject({ state: "committed" });
  expect(g.requests).toHaveLength(1);
  toolGate.open();
  await g.waitFor(() => g.results()[0], "the result");
  expect(g.requests).toHaveLength(2);
  expect(JSON.stringify(g.requests[1]!.messages)).toContain("peer says hi");
  expect(g.results()).toHaveLength(1);
  await g.waitFor(() => journalRecords(home)[0]?.state === "in_transcript" ? true : undefined, "journal in_transcript");
  const lines = transcriptLinesFor(home, "r1");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ type: "attachment", attachment: { type: "queued_command", prompt: "peer says hi", inputId: "r1" } });
});

test("clearQueuedInput drops host input but never a committed journal input, and its count excludes it", async () => {
  const { home, cwd } = fresh("clear");
  const toolGate = gate();
  const g = guest({ home, cwd, toolGate, script: (_r, call) => (call === 0 ? { tool: true } : { text: "done" }) });
  g.send({ type: "user", text: "work" });
  await g.waitFor(() => g.toolRuns.length > 0 ? true : undefined, "the tool call");
  g.send({ type: "user", text: "ordinary queued host input" });
  await g.hold("r1", "a", "peer message that must survive");
  await g.commit("r1", "a");
  const cleared = await g.control("clear_queued_input", undefined);
  expect(cleared).toMatchObject({ ok: true, payload: { cleared: 1 } });
  toolGate.open();
  await g.waitFor(() => g.results()[0], "the result");
  const seen = g.texts().join("");
  expect(seen).toContain("peer message that must survive");
  expect(seen).not.toContain("ordinary queued host input");
  await g.waitFor(() => journalRecords(home)[0]?.state === "in_transcript" ? true : undefined, "journal in_transcript");
  expect(transcriptLinesFor(home, "r1")).toHaveLength(1);
});

test("a committed input behind other work queues (outcome queued) and still reaches the transcript exactly once", async () => {
  const { home, cwd } = fresh("queue");
  const g = guest({ home, cwd });
  await g.hold("r1", "a", "first peer");
  await g.hold("r2", "a", "second peer");
  expect(await g.commit("r1", "a")).toMatchObject({ ok: true, payload: { outcome: "started" } });
  const second = await g.commit("r2", "a");
  expect(["queued", "folded", "started"]).toContain(second.payload.outcome);
  await g.waitFor(() => g.results().length >= 2 ? true : undefined, "two results");
  await g.waitFor(() => journalRecords(home).filter(r => r.state === "in_transcript").length === 2 ? true : undefined, "both in transcript");
  expect(transcriptLinesFor(home, "r1")).toHaveLength(1);
  expect(transcriptLinesFor(home, "r2")).toHaveLength(1);
});

// --- restarts: the journal, the transcript dedupe and the always-emitted held_inputs -----------------------------

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { journalPath } from "./held-input-harness.ts";

async function crash(g: Guest): Promise<void> {
  g.kill();
  await Promise.race([g.proc.exited, sleep(200)]);
}

test("a held input survives a restart: it is reported with its token, starts nothing, and the host decides with that REPORTED token", async () => {
  const { home, cwd } = fresh("restart-held");
  const first = guest({ home, cwd });
  await first.hold("r1", "a", "survives");
  await crash(first);
  const second = guest({ home, cwd });
  const held = await second.waitFor(() => second.system("held_inputs")[0], "held_inputs after restart");
  expect(held.inputs).toEqual([{ inputId: "r1", digest: expect.stringMatching(/^[0-9a-f]{64}$/), holdToken: tokenOf("a"), state: "held" }]);
  await sleep(150);
  expect(second.requests).toHaveLength(0);                       // nothing held starts a turn until the host decides
  expect(await second.discard("r1", "a")).toMatchObject({ ok: true, payload: { discarded: true } });
  expect(journalRecords(home)).toEqual([]);
});

test("guest dies after the hold, before any commit: reconciliation can still commit it with the reported token", async () => {
  const { home, cwd } = fresh("restart-commit-after");
  const first = guest({ home, cwd });
  await first.hold("r1", "a", "late commit");
  await crash(first);
  const second = guest({ home, cwd });
  await second.waitFor(() => second.system("held_inputs")[0], "held_inputs");
  expect(await second.commit("r1", "a")).toMatchObject({ ok: true, payload: { outcome: "started" } });
  await second.waitFor(() => second.results()[0], "the turn");
  expect(second.texts().join("")).toContain("late commit");
});

test("guest dies after journaling `committed`, before the transcript append: the restart feeds it FIRST, lists it as committed, and it reaches the transcript exactly once", async () => {
  const { home, cwd } = fresh("restart-committed");
  const toolGate = gate();
  const first = guest({ home, cwd, toolGate, script: (_r, call) => (call === 0 ? { tool: true } : { text: "ok" }) });
  first.send({ type: "user", text: "an ordinary first turn" });
  await first.waitFor(() => first.toolRuns.length > 0 ? true : undefined, "the tool call");
  await first.hold("r1", "a", "committed but not appended");
  expect(await first.commit("r1", "a")).toMatchObject({ ok: true, payload: { outcome: "folded" } });
  expect(transcriptLinesFor(home, "r1")).toHaveLength(0);       // still waiting for the next user-message point
  await crash(first);
  expect(journalRecords(home)[0]).toMatchObject({ state: "committed" });
  const second = guest({ home, cwd, resume: true, sessionId: first.sessionId });
  // an ordinary input sent at once must still come AFTER the committed one
  second.send({ type: "user", text: "ordinary input sent at startup" });
  const held = await second.waitFor(() => second.system("held_inputs")[0], "held_inputs");
  expect(held.inputs).toMatchObject([{ inputId: "r1", state: "committed", holdToken: tokenOf("a") }]);
  await second.waitFor(() => second.results().length >= 2 ? true : undefined, "two results");
  const requestText = second.requests.map(request => JSON.stringify(request.messages.at(-1)));
  expect(requestText[0]).toContain("committed but not appended");
  expect(requestText[1]).toContain("ordinary input sent at startup");
  await second.waitFor(() => journalRecords(home)[0]?.state === "in_transcript" ? true : undefined, "journal in_transcript");
  expect(transcriptLinesFor(home, "r1")).toHaveLength(1);
});

test("guest dies after the transcript append, before the journal says in_transcript: the restart dedupes by inputId and feeds nothing", async () => {
  const { home, cwd } = fresh("restart-dedupe");
  const first = guest({ home, cwd });
  await first.hold("r1", "a", "already in the transcript");
  await first.commit("r1", "a");
  await first.waitFor(() => first.results()[0], "the turn");
  await first.waitFor(() => journalRecords(home)[0]?.state === "in_transcript" ? true : undefined, "journal in_transcript");
  await crash(first);
  // rewind the journal to the crash window: the append happened, the mark did not
  const path = journalPath(home)!;
  const journal = JSON.parse(readFileSync(path, "utf8"));
  journal.records[0] = { ...journal.records[0], state: "committed", text: "already in the transcript", clientName: "peer" };
  writeFileSync(path, JSON.stringify(journal));
  const second = guest({ home, cwd, resume: true, sessionId: first.sessionId });
  const held = await second.waitFor(() => second.system("held_inputs")[0], "held_inputs");
  expect(held.inputs).toEqual([]);                               // a tombstone is not reported
  expect(journalRecords(home)[0]).toMatchObject({ inputId: "r1", state: "in_transcript" });
  await sleep(200);
  expect(second.requests).toHaveLength(0);                       // not fed again
  expect(transcriptLinesFor(home, "r1")).toHaveLength(1);
  expect(await second.commit("r1", "a")).toMatchObject({ ok: true, payload: { outcome: "already" } });
  // a lost forget is harmless: the tombstone stays until a later forget
  expect(journalRecords(home)).toHaveLength(1);
  expect(await second.forget("r1", "a")).toMatchObject({ ok: true, payload: { forgotten: true } });
  expect(journalRecords(home)).toEqual([]);
});

test("an unreadable journal is kept aside and never trusted: the restart starts empty and the commit is the terminal unknown_input", async () => {
  const { home, cwd } = fresh("corrupt");
  const first = guest({ home, cwd });
  await first.hold("r1", "a");
  await crash(first);
  const path = journalPath(home)!;
  writeFileSync(path, "{ torn");
  const second = guest({ home, cwd });
  const held = await second.waitFor(() => second.system("held_inputs")[0], "held_inputs");
  expect(held.inputs).toEqual([]);
  expect(readdirSync(dirname(path)).some(name => name.startsWith("held-inputs.json.corrupt-"))).toBe(true);
  expect(await second.commit("r1", "a")).toMatchObject({ ok: false, error: { code: "unknown_input" } });
});

test("a run with no journal (the ordinary local leg) never emits held_inputs and answers the verbs as unknown control subtypes", async () => {
  const { home, cwd } = fresh("none");
  const { inMemoryProcess } = await import("../testing.ts");
  const config = { sessionId: "22222222-2222-4222-8222-222222222222", cwd, model: "winter-test/echo", persistSession: true, winterHome: home, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, sandbox: { enabled: false } };
  const proc = inMemoryProcess(["--run", "--config-json", JSON.stringify(config)], { async generate() { return { kind: "text", text: "ok" }; } }, undefined, { WINTER_HOME: home });
  const seen: string[] = [];
  void (async () => { for await (const chunk of proc.stdout) seen.push(chunk); })();
  proc.stdin.write(JSON.stringify({ type: "control_request", requestId: "x", subtype: "host_input_commit", payload: { inputId: "r1", holdToken: tokenOf("a") } }) + "\n");
  await sleep(400);
  proc.stdin.end(); proc.kill();
  const text = seen.join("");
  expect(text).not.toContain("held_inputs");
  expect(text).not.toContain('"outcome"');
});

test("a replayed hold after forget is answered {held:false, state:in_transcript} and the input is never delivered twice", async () => {
  const { home, cwd } = fresh("replay");
  const g = guest({ home, cwd });
  await g.hold("r1", "a", "only once");
  await g.commit("r1", "a");
  await g.waitFor(() => journalRecords(home)[0]?.state === "in_transcript" ? true : undefined, "journal in_transcript");
  expect(await g.forget("r1", "a")).toMatchObject({ ok: true, payload: { forgotten: true } });
  expect(journalRecords(home)).toEqual([]);
  // The tombstone is gone but the transcript holds the id: a re-offer must not hold it again.
  expect(await g.hold("r1", "b", "only once")).toMatchObject({ ok: true, payload: { held: false, state: "in_transcript" } });
  expect(journalRecords(home)).toEqual([]);
  expect(await g.commit("r1", "b")).toMatchObject({ ok: true, payload: { outcome: "already" } });
  await sleep(150);
  expect(transcriptLinesFor(home, "r1")).toHaveLength(1);
  expect(g.texts().join("").split("only once").length - 1).toBeLessThanOrEqual(1);
  // And across a restart: the transcript dedupe seeds the same knowledge.
  g.kill();
  await Promise.race([g.proc.exited, sleep(300)]);
  const again = guest({ home, cwd, resume: true });
  await again.waitFor(() => again.system("held_inputs")[0], "held_inputs");
  expect(await again.hold("r1", "c", "only once")).toMatchObject({ ok: true, payload: { held: false, state: "in_transcript" } });
  expect(await again.commit("r1", "c")).toMatchObject({ ok: true, payload: { outcome: "already" } });
  expect(transcriptLinesFor(home, "r1")).toHaveLength(1);
});
