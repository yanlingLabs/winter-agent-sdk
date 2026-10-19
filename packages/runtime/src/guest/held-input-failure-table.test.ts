/**
 * N2 extensions 4.5, the failure table: every row, end to end. A small MODEL OF THE HOST (the ledger's `offer`/`ack`/`verdict`/`confirmCommitted`/
 * `deliveredUnconfirmed` and the `drainOnce` algorithm of 4.5, rule for rule) drives a REAL guest runtime (the engine, the journal, the transcript)
 * through `inMemoryProcess`, with a fault injected at each point of the table. Each row asserts what the table says reaches the model: the
 * count of tagged transcript entries (exactly once, or zero) and whether the model has seen the text.
 */
import { createHash } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { gate, journalPath, journalRecords, sleep, startGuest, tempRoot, transcriptLinesFor, type Guest, type GuestOptions } from "./held-input-harness.ts";
import { readFileSync, writeFileSync, rmSync as rm } from "node:fs";

class TypedRefusal extends Error { constructor(readonly code: "authority_denied" | "stale_acknowledgment") { super(code); } }
type Receipt = { receiptId: string; text: string; state: "accepted" | "blocked" | "delivered"; offerCount: number; ackedHoldToken?: string; commitConfirmed?: boolean; outcome?: string };

class Ledger {
  receipts: Receipt[] = [];
  revoked = false;
  ackFault: "typed-authority" | "typed-stale" | "untyped-lost" | "untyped-landed" | undefined;
  verdictFails = false;
  add(receiptId: string, text: string): void { this.receipts.push({ receiptId, text, state: "accepted", offerCount: 0 }); }
  get(id: string): Receipt { return this.receipts.find(r => r.receiptId === id)!; }
  offer(): { receiptId: string; text: string; offerCount: number } | undefined {
    const next = this.receipts.find(r => r.state === "accepted" || r.state === "blocked");
    if (next === undefined) return undefined;
    next.offerCount++;
    return { receiptId: next.receiptId, text: next.text, offerCount: next.offerCount };
  }
  ack(receiptId: string, holdToken: string): void {
    const receipt = this.get(receiptId);
    if (this.revoked) { receipt.state = "blocked"; throw new TypedRefusal("authority_denied"); }
    if (this.ackFault === "typed-authority") { this.ackFault = undefined; throw new TypedRefusal("authority_denied"); }
    if (this.ackFault === "typed-stale") { this.ackFault = undefined; throw new TypedRefusal("stale_acknowledgment"); }
    if (this.ackFault === "untyped-lost") { this.ackFault = undefined; throw new Error("transport lost; the ack did not land"); }
    receipt.state = "delivered"; receipt.ackedHoldToken = holdToken; receipt.text = "";   // the body is deleted at the ack
    if (this.ackFault === "untyped-landed") { this.ackFault = undefined; throw new Error("transport lost after the ack landed"); }
  }
  verdict(receiptId: string): { action: "commit"; ackedHoldToken: string } | { action: "discard" } {
    if (this.verdictFails) throw new Error("verdict unreadable");
    const receipt = this.get(receiptId);
    return receipt.state === "delivered" ? { action: "commit", ackedHoldToken: receipt.ackedHoldToken! } : { action: "discard" };
  }
  confirmCommitted(receiptId: string, outcome: string): void { const r = this.get(receiptId); r.commitConfirmed = true; r.outcome = outcome; }
  deliveredUnconfirmed(): Receipt[] { return this.receipts.filter(r => r.state === "delivered" && r.commitConfirmed !== true); }
}

const holdTokenOf = (receiptId: string, incarnationId: string, leaseEpoch: number, offerCount: number): string =>
  createHash("sha256").update(`hold-v1|${receiptId}|${incarnationId}|${leaseEpoch}|${offerCount}`).digest("hex");

/** The driver: the host's four verbs over one live guest, with faults the table needs. */
class Driver {
  dropNextRequest: "hold" | "commit" | "forget" | "discard" | undefined;
  dropNextAnswer: "hold" | "commit" | "forget" | "discard" | undefined;
  constructor(public guest: Guest, public epoch = { incarnationId: "inc-1", leaseEpoch: 1 }) {}
  private async call(verb: "hold" | "commit" | "forget" | "discard", subtype: string, payload: unknown): Promise<any> {
    if (this.dropNextRequest === verb) { this.dropNextRequest = undefined; throw new Error(`${verb} request lost`); }
    const answer = await this.guest.control(subtype, payload);
    if (this.dropNextAnswer === verb) { this.dropNextAnswer = undefined; throw new Error(`${verb} answer lost`); }
    if (!answer.ok) throw Object.assign(new Error(answer.error!.code), { code: answer.error!.code });
    return answer.payload;
  }
  hold(inputId: string, holdToken: string, text: string) { return this.call("hold", "host_input_hold", { inputId, holdToken, epoch: this.epoch, text, clientName: "peer" }); }
  commit(inputId: string, holdToken: string) { return this.call("commit", "host_input_commit", { inputId, holdToken }); }
  discard(inputId: string, holdToken: string) { return this.call("discard", "host_input_discard", { inputId, holdToken }); }
  forget(inputId: string, holdToken: string) { return this.call("forget", "host_input_forget", { inputId, holdToken }); }
}

const lost: string[] = [];   // the "surface it" note for a terminal unknown_input

/** 4.5's drainOnce for one recipient, rule for rule. */
async function drainOnce(ledger: Ledger, driver: Driver): Promise<void> {
  for (const receipt of ledger.deliveredUnconfirmed()) {                     // rule 3: finish what is delivered first, oldest first
    try {
      const answer = await driver.commit(receipt.receiptId, receipt.ackedHoldToken!);
      ledger.confirmCommitted(receipt.receiptId, answer.outcome);
      await driver.forget(receipt.receiptId, receipt.ackedHoldToken!).catch(() => undefined);
    } catch (error) {
      if ((error as { code?: string }).code === "unknown_input") { ledger.confirmCommitted(receipt.receiptId, "lost"); lost.push(receipt.receiptId); continue; }
      return;                                                                // nothing newer is offered past an unconfirmed commit
    }
  }
  const offer = ledger.offer();
  if (offer === undefined) return;
  let token = holdTokenOf(offer.receiptId, driver.epoch.incarnationId, driver.epoch.leaseEpoch, offer.offerCount);
  try { await driver.hold(offer.receiptId, token, offer.text); } catch { return; }
  try { ledger.ack(offer.receiptId, token); } catch (error) {
    if (error instanceof TypedRefusal) { await driver.discard(offer.receiptId, token).catch(() => undefined); return; }
    let verdict: ReturnType<Ledger["verdict"]>;
    try { verdict = ledger.verdict(offer.receiptId); } catch { return; }       // the hold stays undecided
    if (verdict.action === "commit") token = verdict.ackedHoldToken;
    else { await driver.discard(offer.receiptId, token).catch(() => undefined); return; }
  }
  let outcome: string;
  try { outcome = (await driver.commit(offer.receiptId, token)).outcome; } catch { return; }   // rule 3 retries it on the next drain
  ledger.confirmCommitted(offer.receiptId, outcome);
  await driver.forget(offer.receiptId, token).catch(() => undefined);
}

/** Rule 1: reconcile every entry the runtime reported before any new offer. */
async function reconcile(ledger: Ledger, driver: Driver): Promise<void> {
  const held = await driver.guest.waitFor(() => driver.guest.system("held_inputs")[0], "held_inputs");
  for (const entry of held.inputs as Array<{ inputId: string; holdToken: string; state: string }>) {
    if (entry.state === "held") {
      const verdict = ledger.verdict(entry.inputId);
      if (verdict.action === "commit") await driver.commit(entry.inputId, verdict.ackedHoldToken);
      else await driver.discard(entry.inputId, entry.holdToken);             // the token the runtime REPORTED
    } else if (entry.state === "committed") {
      const receipt = ledger.receipts.find(r => r.receiptId === entry.inputId);
      if (receipt && receipt.commitConfirmed !== true) ledger.confirmCommitted(entry.inputId, "already");
    }
  }
}

const open: Guest[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const g of open.splice(0)) { try { g.send({ type: "control_request", requestId: "fin", subtype: "end_input" }); g.proc.stdin.end(); await Promise.race([g.proc.exited, sleep(150)]); } catch { /* gone */ } g.kill(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  lost.length = 0;
});
function world(label: string) {
  const t = tempRoot(label);
  roots.push(dirname(t.home));
  const ledger = new Ledger();
  const start = (extra: Partial<GuestOptions> = {}, epoch = { incarnationId: "inc-1", leaseEpoch: 1 }): Driver => {
    const guest = startGuest({ ...t, epoch, ...extra });
    open.push(guest);
    return new Driver(guest, epoch);
  };
  return { ...t, ledger, start };
}
const delivered = (home: string, id: string): number => transcriptLinesFor(home, id).length;
const modelSaw = (g: Guest, text: string): boolean => g.texts().join("").includes(text);
const crashed = async (g: Guest): Promise<void> => { g.kill(); await Promise.race([g.proc.exited, sleep(200)]); };
const settled = async (home: string, id: string): Promise<void> => { for (let i = 0; i < 80 && journalRecords(home).find(r => r.inputId === id)?.state !== "in_transcript"; i++) await sleep(50); };

test("row 1a: the hold fails before it reaches the guest: nothing held, nothing delivered; the re-offer holds under a new token and delivers once", async () => {
  const w = world("row1a");
  w.ledger.add("m1", "row one message");
  const d = w.start();
  d.dropNextRequest = "hold";
  await drainOnce(w.ledger, d);
  expect(journalRecords(w.home)).toEqual([]);
  expect(w.ledger.get("m1").state).toBe("accepted");
  expect(modelSaw(d.guest, "row one message")).toBe(false);
  await drainOnce(w.ledger, d);
  await settled(w.home, "m1");
  expect(w.ledger.get("m1")).toMatchObject({ state: "delivered", commitConfirmed: true });
  expect(delivered(w.home, "m1")).toBe(1);
});

test("row 1b: the guest dies after holding, before the host hears: the hold is `held`, undelivered; the re-offer (offerCount 2) replaces the token and delivers once", async () => {
  const w = world("row1b");
  w.ledger.add("m1", "row one b message");
  const d = w.start();
  d.dropNextAnswer = "hold";
  await drainOnce(w.ledger, d);                                    // the hold landed, its answer was lost: the host re-owes it
  expect(journalRecords(w.home)[0]).toMatchObject({ state: "held" });
  const firstToken = journalRecords(w.home)[0]!.holdToken;
  expect(w.ledger.get("m1").state).toBe("accepted");
  expect(modelSaw(d.guest, "row one b message")).toBe(false);
  await drainOnce(w.ledger, d);
  expect(w.ledger.get("m1").ackedHoldToken).not.toBe(firstToken);                    // the token was replaced by the re-hold
  await settled(w.home, "m1");
  expect(delivered(w.home, "m1")).toBe(1);
});

test("row 2: authority revoked between hold and ack: the ack is refused, the hold is discarded, nothing reaches the model; after the re-grant it is delivered exactly once", async () => {
  const w = world("row2");
  w.ledger.add("m1", "revoked then granted");
  const d = w.start();
  w.ledger.revoked = true;
  await drainOnce(w.ledger, d);
  expect(w.ledger.get("m1").state).toBe("blocked");
  expect(journalRecords(w.home)).toEqual([]);                     // the discard removed the hold
  expect(modelSaw(d.guest, "revoked then granted")).toBe(false);
  w.ledger.revoked = false;
  await drainOnce(w.ledger, d);
  await settled(w.home, "m1");
  expect(delivered(w.home, "m1")).toBe(1);
  expect(modelSaw(d.guest, "revoked then granted")).toBe(true);
});

test("row 3: the ack throws a typed refusal (authority_denied, then stale_acknowledgment): discard now, the next drain re-offers; zero, then exactly one", async () => {
  const w = world("row3");
  w.ledger.add("m1", "typed refusals");
  const d = w.start();
  for (const fault of ["typed-authority", "typed-stale"] as const) {
    w.ledger.ackFault = fault;
    await drainOnce(w.ledger, d);
    expect(journalRecords(w.home)).toEqual([]);
    expect(w.ledger.get("m1").state).toBe("accepted");
    expect(delivered(w.home, "m1")).toBe(0);
  }
  await drainOnce(w.ledger, d);
  await settled(w.home, "m1");
  expect(delivered(w.home, "m1")).toBe(1);
});

test("row 4: the ack throws anything else and did NOT land: verdict says discard, the hold is discarded, the next drain re-offers; zero, then exactly one", async () => {
  const w = world("row4");
  w.ledger.add("m1", "ack lost in transit");
  const d = w.start();
  w.ledger.ackFault = "untyped-lost";
  await drainOnce(w.ledger, d);
  expect(w.ledger.get("m1").state).toBe("accepted");
  expect(journalRecords(w.home)).toEqual([]);
  expect(delivered(w.home, "m1")).toBe(0);
  await drainOnce(w.ledger, d);
  await settled(w.home, "m1");
  expect(delivered(w.home, "m1")).toBe(1);
});

test("row 5: the ack throws anything else but DID land: verdict says commit with the acked token, committed now; exactly one", async () => {
  const w = world("row5");
  w.ledger.add("m1", "ack landed but looked lost");
  const d = w.start();
  w.ledger.ackFault = "untyped-landed";
  await drainOnce(w.ledger, d);
  expect(w.ledger.get("m1")).toMatchObject({ state: "delivered", commitConfirmed: true });
  await settled(w.home, "m1");
  expect(delivered(w.home, "m1")).toBe(1);
});

test("row 6a: the ack throws and verdict() also throws, ledger still accepted: nothing is decided; the next drain re-offers, re-holds (token replaced) and delivers once", async () => {
  const w = world("row6a");
  w.ledger.add("m1", "verdict unreadable");
  const d = w.start();
  w.ledger.ackFault = "untyped-lost";
  w.ledger.verdictFails = true;
  await drainOnce(w.ledger, d);
  expect(journalRecords(w.home)[0]).toMatchObject({ state: "held" });
  expect(delivered(w.home, "m1")).toBe(0);
  const stale = journalRecords(w.home)[0]!.holdToken;
  w.ledger.verdictFails = false;
  await drainOnce(w.ledger, d);
  await settled(w.home, "m1");
  expect(delivered(w.home, "m1")).toBe(1);
  expect(stale).not.toBe(w.ledger.get("m1").ackedHoldToken);
});

test("row 6b: the ack landed (delivered) and verdict() throws: rule 3 commits it with ackedHoldToken on the next drain; exactly one", async () => {
  const w = world("row6b");
  w.ledger.add("m1", "delivered, verdict unreadable");
  const d = w.start();
  w.ledger.ackFault = "untyped-landed";
  w.ledger.verdictFails = true;
  await drainOnce(w.ledger, d);
  expect(w.ledger.get("m1")).toMatchObject({ state: "delivered" });
  expect(w.ledger.get("m1").commitConfirmed).toBeUndefined();
  expect(delivered(w.home, "m1")).toBe(0);
  await drainOnce(w.ledger, d);
  await settled(w.home, "m1");
  expect(w.ledger.get("m1").commitConfirmed).toBe(true);
  expect(delivered(w.home, "m1")).toBe(1);
});

test("row 6c: the ack throws, verdict() throws, and the runtime restarts: reconciliation decides it; exactly one", async () => {
  const w = world("row6c");
  w.ledger.add("m1", "decided by reconciliation");
  const d1 = w.start();
  w.ledger.ackFault = "untyped-landed";
  w.ledger.verdictFails = true;
  await drainOnce(w.ledger, d1);
  await crashed(d1.guest);
  w.ledger.verdictFails = false;
  const d2 = w.start();
  await reconcile(w.ledger, d2);                                   // delivered => commit with the ledger's token, before any offer
  await settled(w.home, "m1");
  expect(delivered(w.home, "m1")).toBe(1);
});

test("row 7: the host dies after the ack, before the commit: the next drain re-commits it first (rule 3); exactly one", async () => {
  const w = world("row7");
  w.ledger.add("m1", "host died after ack");
  const d = w.start();
  d.dropNextRequest = "commit";
  await drainOnce(w.ledger, d);                                    // hold + ack done, commit never sent
  expect(w.ledger.get("m1").state).toBe("delivered");
  expect(journalRecords(w.home)[0]).toMatchObject({ state: "held" });
  expect(delivered(w.home, "m1")).toBe(0);
  await drainOnce(w.ledger, d);
  await settled(w.home, "m1");
  expect(delivered(w.home, "m1")).toBe(1);
  expect(w.ledger.get("m1").commitConfirmed).toBe(true);
});

test("row 7b: the host dies after the ack and the runtime restarted too: reconciliation commits it before any offer; exactly one", async () => {
  const w = world("row7b");
  w.ledger.add("m1", "both died");
  const d1 = w.start();
  d1.dropNextRequest = "commit";
  await drainOnce(w.ledger, d1);
  await crashed(d1.guest);
  const d2 = w.start();
  await reconcile(w.ledger, d2);
  await settled(w.home, "m1");
  expect(delivered(w.home, "m1")).toBe(1);
});

test("row 8: the commit ANSWER is lost but the runtime keeps running: the next drain re-sends commit and gets `already`; exactly one, ledger confirmed", async () => {
  const w = world("row8");
  w.ledger.add("m1", "commit answer lost");
  const d = w.start();
  d.dropNextAnswer = "commit";
  await drainOnce(w.ledger, d);
  expect(w.ledger.get("m1").commitConfirmed).toBeUndefined();
  await settled(w.home, "m1");
  expect(delivered(w.home, "m1")).toBe(1);
  await drainOnce(w.ledger, d);
  expect(w.ledger.get("m1")).toMatchObject({ commitConfirmed: true, outcome: "already" });
  expect(delivered(w.home, "m1")).toBe(1);
});

test("row 9: the commit is sent and the guest dies before journaling it: the record is still `held`; reconciliation commits it before the new epoch is published; exactly one", async () => {
  const w = world("row9");
  w.ledger.add("m1", "died before journaling the commit");
  const d1 = w.start();
  d1.dropNextRequest = "commit";                                   // the guest never saw the commit
  await drainOnce(w.ledger, d1);
  await crashed(d1.guest);
  const d2 = w.start();
  await reconcile(w.ledger, d2);
  await settled(w.home, "m1");
  expect(delivered(w.home, "m1")).toBe(1);
});

test("row 10: the guest dies after journaling `committed`, before the transcript append: the restart feeds it first; the host only confirms; exactly one", async () => {
  const w = world("row10");
  w.ledger.add("m1", "committed then died");
  const toolGate = gate();
  const d1 = w.start({ toolGate, script: (_r, call) => (call === 0 ? { tool: true } : { text: "ok" }) });
  d1.guest.send({ type: "user", text: "ordinary turn holding the tool" });
  await d1.guest.waitFor(() => d1.guest.toolRuns.length > 0 ? true : undefined, "tool");
  await drainOnce(w.ledger, d1);                                   // folds: committed, not yet in the transcript
  expect(journalRecords(w.home)[0]).toMatchObject({ state: "committed" });
  expect(delivered(w.home, "m1")).toBe(0);
  await crashed(d1.guest);
  const d2 = w.start({ resume: true, sessionId: d1.guest.sessionId });
  await reconcile(w.ledger, d2);
  await settled(w.home, "m1");
  expect(delivered(w.home, "m1")).toBe(1);
  expect(w.ledger.get("m1").commitConfirmed).toBe(true);
});

test("row 11: the guest dies after the transcript append, before the journal says in_transcript: the restart dedupes by inputId and never feeds it again; exactly one", async () => {
  const w = world("row11");
  w.ledger.add("m1", "appended then died");
  const d1 = w.start();
  await drainOnce(w.ledger, d1);
  await settled(w.home, "m1");
  await crashed(d1.guest);
  const path = journalPath(w.home)!;
  const journal = JSON.parse(readFileSync(path, "utf8"));
  journal.records[0] = { ...journal.records[0], state: "committed", text: "appended then died", clientName: "peer" };
  writeFileSync(path, JSON.stringify(journal));
  const d2 = w.start({ resume: true, sessionId: d1.guest.sessionId });
  await reconcile(w.ledger, d2);
  await sleep(200);
  expect(d2.guest.requests).toHaveLength(0);
  expect(delivered(w.home, "m1")).toBe(1);
});

test("row 12: the guest restarts with a new epoch while holding and the ledger record is still accepted: reconciliation discards the old hold with its REPORTED token, then re-offer, hold, ack and commit under the new epoch; exactly one", async () => {
  const w = world("row12");
  w.ledger.add("m1", "held across an epoch change");
  const d1 = w.start();
  w.ledger.ackFault = "untyped-lost"; w.ledger.verdictFails = true;
  await drainOnce(w.ledger, d1);                                   // hold landed, nothing decided
  const oldToken = journalRecords(w.home)[0]!.holdToken;
  await crashed(d1.guest);
  w.ledger.verdictFails = false;
  const d2 = w.start({}, { incarnationId: "inc-2", leaseEpoch: 2 });
  await reconcile(w.ledger, d2);                                   // ledger says accepted => discard with the reported token
  expect(journalRecords(w.home)).toEqual([]);
  await drainOnce(w.ledger, d2);
  await settled(w.home, "m1");
  expect(delivered(w.home, "m1")).toBe(1);
  expect(w.ledger.get("m1").ackedHoldToken).not.toBe(oldToken);
  // and the old epoch can no longer hold
  await expect(d1.hold("x", oldToken, "stale epoch")).rejects.toBeDefined();
});

test("row 13: a stale discard or commit (an old token) arrives after a re-hold: superseded, nothing changes; the ack and commit proceed under the new token; exactly one", async () => {
  const w = world("row13");
  w.ledger.add("m1", "stale verdicts");
  const d = w.start();
  const t1 = holdTokenOf("m1", "inc-1", 1, 1), t2 = holdTokenOf("m1", "inc-1", 1, 2);
  await d.hold("m1", t1, "stale verdicts");
  await d.hold("m1", t2, "stale verdicts");                        // the re-hold replaces the token
  await expect(d.commit("m1", t1)).rejects.toMatchObject({ code: "superseded" });
  expect(await d.discard("m1", t1)).toEqual({ discarded: false, reason: "superseded" });
  expect(journalRecords(w.home)[0]).toMatchObject({ state: "held", holdToken: t2 });
  expect(delivered(w.home, "m1")).toBe(0);
  w.ledger.get("m1").offerCount = 2;
  w.ledger.ack("m1", t2);
  await d.commit("m1", t2);
  await settled(w.home, "m1");
  expect(delivered(w.home, "m1")).toBe(1);
});

test("row 14: clearQueuedInput while a committed input waits in the queue: the clear skips it and the input still reaches the transcript; exactly one", async () => {
  const w = world("row14");
  w.ledger.add("m1", "must survive the clear");
  const toolGate = gate();
  const d = w.start({ toolGate, script: (_r, call) => (call === 0 ? { tool: true } : { text: "ok" }) });
  d.guest.send({ type: "user", text: "running turn" });
  await d.guest.waitFor(() => d.guest.toolRuns.length > 0 ? true : undefined, "tool");
  await drainOnce(w.ledger, d);
  expect((await d.guest.control("clear_queued_input", undefined)).payload).toEqual({ cleared: 0 });
  toolGate.open();
  await settled(w.home, "m1");
  expect(delivered(w.home, "m1")).toBe(1);
  expect(modelSaw(d.guest, "must survive the clear")).toBe(true);
});

test("row 15: the commit is answered unknown_input (volume loss): terminal, confirmed `lost`, surfaced, never retried; the recipient's later messages still flow", async () => {
  const w = world("row15");
  w.ledger.add("m1", "lost with the volume");
  w.ledger.add("m2", "a later message");
  const d = w.start();
  d.dropNextRequest = "commit";
  await drainOnce(w.ledger, d);                                    // m1 delivered, commit unsent
  rm(journalPath(w.home)!);                                        // the data volume lost the journal; the runtime restarts
  await crashed(d.guest);
  const d2 = w.start();
  await d2.guest.waitFor(() => d2.guest.system("held_inputs")[0], "held_inputs");
  await drainOnce(w.ledger, d2);                                   // rule 3: commit m1 => unknown_input => lost, continue
  expect(lost).toEqual(["m1"]);
  expect(w.ledger.get("m1")).toMatchObject({ commitConfirmed: true, outcome: "lost" });
  expect(delivered(w.home, "m1")).toBe(0);
  await drainOnce(w.ledger, d2);                                   // a lost record never blocks the recipient's later messages
  await settled(w.home, "m2");
  expect(delivered(w.home, "m2")).toBe(1);
  await drainOnce(w.ledger, d2);
  expect(lost).toEqual(["m1"]);                                    // never retried
});

test("row 16: host_input_forget is lost: the tombstone stays, harmless; delivery stays exactly once; a later forget clears it", async () => {
  const w = world("row16");
  w.ledger.add("m1", "forget lost");
  const d = w.start();
  d.dropNextRequest = "forget";
  await drainOnce(w.ledger, d);
  await settled(w.home, "m1");
  expect(journalRecords(w.home)[0]).toMatchObject({ inputId: "m1", state: "in_transcript" });
  expect(delivered(w.home, "m1")).toBe(1);
  await drainOnce(w.ledger, d);
  expect(delivered(w.home, "m1")).toBe(1);
  await d.forget("m1", w.ledger.get("m1").ackedHoldToken!);
  expect(journalRecords(w.home)).toEqual([]);
  expect(await d.commit("m1", w.ledger.get("m1").ackedHoldToken!)).toEqual({ outcome: "already" });   // the transcript is the last word
});
