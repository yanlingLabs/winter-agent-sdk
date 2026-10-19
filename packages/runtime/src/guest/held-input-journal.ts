/**
 * The runtime's held-input journal (N2 extensions design 4.5).
 *
 * A peer message the host accepted is first HELD here, invisible to the model, until the host's ledger
 * decides: `commit` (the input belongs to the conversation), `discard` (it does not), or a re-hold under a
 * newer token. Every record names a hold token, never only an epoch, so a verdict acts only on the exact
 * hold it is about, whatever order frames arrive in.
 *
 *   held          durable, invisible to the model, undecided        -> committed | (deleted) | held (token replaced)
 *   committed     part of the conversation; reaches the transcript   -> in_transcript (after the tagged append)
 *                 exactly once
 *   in_transcript a tombstone: the transcript holds it               -> (deleted) by `forget` with the same token
 *
 * Every change is durable BEFORE the call returns: the whole (small) file is rewritten to a temp file, fsynced,
 * renamed over the journal, and the directory is fsynced. If any of that throws, the in-memory records are
 * unchanged, so a refused write is never remembered as done. The journal never touches the transcript; the
 * engine appends the tagged transcript entry and then calls `markInTranscript`.
 */
import { closeSync, constants as fsConstants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import type { HeldInputEpoch } from "@yanlinglabs/winter-agent-sdk";
import { dirname, join } from "node:path";

export { HELD_INPUT_CAPABILITY } from "@yanlinglabs/winter-agent-sdk";
/** The ledger's own cap per recipient. */
export const HELD_INPUT_MAX_RECORDS = 256;
/** The 64 KiB message cap. */
export const HELD_INPUT_MAX_TEXT_BYTES = 64 * 1024;
export const HELD_INPUT_MAX_CLIENT_NAME = 256;
export const HELD_INPUT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const HELD_INPUT_TOKEN = /^[0-9a-f]{64}$/;

export type HeldInputState = "held" | "committed" | "in_transcript";
export type HeldInputErrorCode = "invalid" | "conflict" | "superseded" | "unknown_input" | "committed" | "epoch" | "journal_full" | "journal_failed";
export class HeldInputError extends Error {
  readonly code: HeldInputErrorCode;
  constructor(code: HeldInputErrorCode, message: string) {
    super(message);
    this.name = "HeldInputError";
    this.code = code;
  }
}

export interface HeldInputRecord {
  inputId: string;
  digest: string;
  holdToken: string;
  state: HeldInputState;
  /** Present while `held` or `committed`; a tombstone keeps only the identity (the transcript has the body). */
  text?: string;
  clientName?: string;
}
export interface HeldInputHold { inputId: string; holdToken: string; text: string; clientName: string }
export type HeldInputHoldResult = { held: true; again?: true } | { held: false; state: "committed" | "in_transcript" };
export type HeldInputCommitResult = { kind: "committed"; record: Readonly<HeldInputRecord> } | { kind: "already" };
export type HeldInputDiscardResult = { discarded: true } | { discarded: false; reason: "superseded" };

export interface HeldInputJournal {
  /** A copy of every record, oldest first. */
  list(): HeldInputRecord[];
  hold(request: HeldInputHold): HeldInputHoldResult;
  commit(inputId: string, holdToken: string): HeldInputCommitResult;
  discard(inputId: string, holdToken: string): HeldInputDiscardResult;
  forget(inputId: string, holdToken: string): { forgotten: boolean };
  /** committed -> in_transcript, after the tagged transcript append. Idempotent; a missing or held record is left alone. */
  markInTranscript(inputId: string): void;
  /**
   * Restart dedupe: a `held` or `committed` record whose inputId the transcript already holds becomes `in_transcript`.
   * Returns the inputIds that moved.
   */
  dedupe(transcriptInputIds: ReadonlySet<string>): string[];
}

/** The durable write seam. Tests inject failures; production uses the real file system. */
export interface HeldInputIo {
  read(path: string): string | undefined;
  /** Atomically and durably replaces `path` with `data` (temp file, fsync, rename, directory fsync). */
  write(path: string, data: string): void;
}
let tempCounter = 0;
export const realHeldInputIo: HeldInputIo = {
  read(path) {
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf8");
  },
  write(path, data) {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = join(directory, `.${process.pid}-${++tempCounter}.held-inputs.tmp`);
    const bytes = Buffer.from(data, "utf8");
    const fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temp, path);
    const dir = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  },
};

export function heldInputDigest(text: string, clientName: string): string {
  return createHash("sha256").update(`${clientName}\n${text}`).digest("hex");
}
/** Where a session's journal lives: beside its transcript, in the protected store. */
export function heldInputJournalPath(durableRoot: string, projectKey: string, sessionId: string): string {
  return join(durableRoot, "projects", projectKey, sessionId, "held-inputs.json");
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseRecords(raw: string): HeldInputRecord[] {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.records) || parsed.records.length > HELD_INPUT_MAX_RECORDS) throw new Error("not a held-input journal");
  const seen = new Set<string>();
  return parsed.records.map((value): HeldInputRecord => {
    if (!isRecord(value) || typeof value.inputId !== "string" || !HELD_INPUT_ID.test(value.inputId) || seen.has(value.inputId)) throw new Error("bad record");
    seen.add(value.inputId);
    const state = value.state;
    if (state !== "held" && state !== "committed" && state !== "in_transcript") throw new Error("bad state");
    if (typeof value.holdToken !== "string" || !HELD_INPUT_TOKEN.test(value.holdToken) || typeof value.digest !== "string" || !HELD_INPUT_TOKEN.test(value.digest)) throw new Error("bad token");
    if (state !== "in_transcript" && (typeof value.text !== "string" || typeof value.clientName !== "string")) throw new Error("bad body");
    return { inputId: value.inputId, digest: value.digest, holdToken: value.holdToken, state, ...(typeof value.text === "string" ? { text: value.text } : {}), ...(typeof value.clientName === "string" ? { clientName: value.clientName } : {}) };
  });
}

function validHold(request: HeldInputHold): void {
  if (!isRecord(request) || typeof request.inputId !== "string" || !HELD_INPUT_ID.test(request.inputId)) throw new HeldInputError("invalid", "inputId");
  if (typeof request.holdToken !== "string" || !HELD_INPUT_TOKEN.test(request.holdToken)) throw new HeldInputError("invalid", "holdToken");
  if (typeof request.text !== "string" || request.text.length === 0 || Buffer.byteLength(request.text) > HELD_INPUT_MAX_TEXT_BYTES) throw new HeldInputError("invalid", "text");
  if (typeof request.clientName !== "string" || request.clientName.length > HELD_INPUT_MAX_CLIENT_NAME) throw new HeldInputError("invalid", "clientName");
}
function validTokenPair(inputId: unknown, holdToken: unknown): void {
  if (typeof inputId !== "string" || !HELD_INPUT_ID.test(inputId)) throw new HeldInputError("invalid", "inputId");
  if (typeof holdToken !== "string" || !HELD_INPUT_TOKEN.test(holdToken)) throw new HeldInputError("invalid", "holdToken");
}

/** What `runEngine` is given to serve the `host_input_*` subtypes: the journal, the inputIds the transcript already holds, and the admitted scope. */
export interface HeldInputSupport {
  journal: HeldInputJournal;
  /** inputIds found tagged in the transcript at startup (empty for a fresh session). */
  transcriptInputIds: ReadonlySet<string>;
  /** The admitted incarnation and lease epoch; a hold for any other epoch is refused. */
  epoch: HeldInputEpoch;
}
export interface OpenedHeldInputJournal { journal: HeldInputJournal; /** Set when an unreadable journal had to be moved aside (its inputs are then reported lost by the host's verdict). */ quarantined?: string }

export function openHeldInputJournal(path: string, io: HeldInputIo = realHeldInputIo): OpenedHeldInputJournal {
  let records: HeldInputRecord[] = [];
  let quarantined: string | undefined;
  const raw = (() => { try { return io.read(path); } catch { throw new HeldInputError("journal_failed", "journal unreadable"); } })();
  if (raw !== undefined) {
    try { records = parseRecords(raw); } catch {
      // A torn or foreign file is never trusted and never silently overwritten: it is kept aside and the journal starts empty, so
      // the host's later verdict for any input in it is `unknown_input` (terminal and visible), not a guess.
      quarantined = `${path}.corrupt-${Date.now()}`;
      try { io.write(quarantined, raw); } catch { throw new HeldInputError("journal_failed", "journal corrupt and not movable"); }
      records = [];
      try { io.write(path, JSON.stringify({ version: 1, records: [] })); } catch { throw new HeldInputError("journal_failed", "journal reset failed"); }
    }
  }
  const persist = (next: HeldInputRecord[]): void => {
    try { io.write(path, JSON.stringify({ version: 1, records: next })); } catch { throw new HeldInputError("journal_failed", "journal write failed"); }
    records = next;
  };
  const find = (inputId: string): HeldInputRecord | undefined => records.find(record => record.inputId === inputId);
  const replace = (next: HeldInputRecord): HeldInputRecord[] => records.map(record => record.inputId === next.inputId ? next : record);
  const journal: HeldInputJournal = {
    list: () => records.map(record => ({ ...record })),
    hold(request) {
      validHold(request);
      const digest = heldInputDigest(request.text, request.clientName);
      const existing = find(request.inputId);
      if (existing === undefined) {
        if (records.length >= HELD_INPUT_MAX_RECORDS) throw new HeldInputError("journal_full", "too many held inputs");
        persist([...records, { inputId: request.inputId, digest, holdToken: request.holdToken, state: "held", text: request.text, clientName: request.clientName }]);
        return { held: true };
      }
      if (existing.state !== "held") return { held: false, state: existing.state };
      if (existing.digest !== digest) throw new HeldInputError("conflict", "inputId already held with a different body");
      // The same input offered again: the token is REPLACED, so a late verdict for the earlier hold answers `superseded`.
      persist(replace({ ...existing, holdToken: request.holdToken }));
      return { held: true, again: true };
    },
    commit(inputId, holdToken) {
      validTokenPair(inputId, holdToken);
      const existing = find(inputId);
      if (existing === undefined) throw new HeldInputError("unknown_input", "no record for this input");
      if (existing.holdToken !== holdToken) throw new HeldInputError("superseded", "another hold token is recorded");
      if (existing.state !== "held") return { kind: "already" };
      const next: HeldInputRecord = { ...existing, state: "committed" };
      persist(replace(next));
      return { kind: "committed", record: { ...next } };
    },
    discard(inputId, holdToken) {
      validTokenPair(inputId, holdToken);
      const existing = find(inputId);
      if (existing === undefined) return { discarded: true };
      if (existing.state !== "held") throw new HeldInputError("committed", "the input is already part of the conversation");
      if (existing.holdToken !== holdToken) return { discarded: false, reason: "superseded" };
      persist(records.filter(record => record.inputId !== inputId));
      return { discarded: true };
    },
    forget(inputId, holdToken) {
      validTokenPair(inputId, holdToken);
      const existing = find(inputId);
      if (existing === undefined) return { forgotten: true };
      if (existing.state !== "in_transcript" || existing.holdToken !== holdToken) return { forgotten: false };
      persist(records.filter(record => record.inputId !== inputId));
      return { forgotten: true };
    },
    markInTranscript(inputId) {
      const existing = find(inputId);
      if (existing === undefined || existing.state !== "committed") return;
      const { text: _text, clientName: _clientName, ...tombstone } = existing;
      persist(replace({ ...tombstone, state: "in_transcript" }));
    },
    dedupe(transcriptInputIds) {
      const moved = records.filter(record => record.state !== "in_transcript" && transcriptInputIds.has(record.inputId)).map(record => record.inputId);
      if (moved.length === 0) return [];
      persist(records.map(record => moved.includes(record.inputId) ? (({ text: _t, clientName: _c, ...rest }) => ({ ...rest, state: "in_transcript" as const }))(record) : record));
      return moved;
    },
  };
  return { journal, ...(quarantined !== undefined ? { quarantined } : {}) };
}
