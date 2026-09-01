// WinterCompatibilitySessionStore — the filesystem-backed SessionStore (WS-05 §6): the single
// implementation Winter v2 and the official branch consume identically.
//
// Layout (WS-05 §6):
//   { projectKey, sessionId }                    -> <home>/projects/<projectKey>/<sessionId>.jsonl
//   { ..., subpath: "subagents/agent-X" }        -> <home>/projects/<projectKey>/<sessionId>/subagents/agent-X.jsonl (+ .meta.json)
// Siblings of the main jsonl: <sessionId>.lock (writer lease), <sessionId>.summary.json (folded
// summary sidecar), <sessionId>.jsonl.tail-quarantine (repaired-away partial tails).
//
// The writer lease is per (projectKey, sessionId) ONLY — never per-subpath (WS-05 §13): a subagent
// append competes for the SAME lease as its parent session's main transcript. See leases.ts.
import {
  mkdirSync,
  lstatSync,
  chmodSync,
  readdirSync,
  readFileSync,
  statSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
  rmSync,
  ftruncateSync,
  constants as fsConstants,
} from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import { acquireLease, writeAllSync, WinterStoreError, WinterStoreLeaseError } from "./leases.ts";

export { WinterStoreError, WinterStoreLeaseError } from "./leases.ts";

// ---- WS-03 §10 pinned SessionStore type family (authored here per Controller Ruling P1-O — the
// type does not exist as code anywhere upstream of this task; Task 10 relocates store+type into
// the sdk package). Names cross-checked against
// packages/conformance/compat/anthropic/0.3.250/exports.json: SessionKey, SessionStore,
// SessionStoreEntry, SessionSummaryEntry are all present there as bare names (kind: "type"), with
// no field-level detail in that names-only snapshot — WS-03 §10's spec text is the only shape
// authority available, and this mirrors it exactly (same field names, same optionality). No
// divergence between the two sources was found for these four names.

export type SessionKey = { projectKey: string; sessionId: string; subpath?: string };

export type SessionStoreEntry = { type: string; uuid?: string; timestamp?: string; [key: string]: unknown };

// NOT pinned by WS-03 §10 or exports.json beyond the bare name "SessionSummaryEntry" — WS-05 §14
// places titles/tags/summaries semantics in the DIALECT layer's conformance corpus, not this
// store's 13-case suite, and no spec text pins concrete fields. This is a deliberately minimal,
// mechanical shape (just enough for listSessionSummaries to be real and testable now): folded
// purely from entry COUNT/TYPE/TIMESTAMP on every append, never interpreting entry semantics.
// Recorded as an explicit Open question in task-7-report.md rather than silently invented.
export type SessionSummaryEntry = {
  sessionId: string;
  entryCount: number;
  mtime: number;
  lastEntryType?: string;
  lastTimestamp?: string;
  [key: string]: unknown;
};

export type SessionStore = {
  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>;
  load(key: SessionKey): Promise<SessionStoreEntry[] | null>;
  listSessions?(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>>;
  listSessionSummaries?(projectKey: string): Promise<SessionSummaryEntry[]>;
  delete?(key: SessionKey): Promise<void>;
  listSubkeys?(key: { projectKey: string; sessionId: string }): Promise<string[]>;
};

// ---------------------------------------------------------------------------------------------
// Path safety. projectKey/sessionId are always a SINGLE path segment (no internal separators);
// subpath is a RELATIVE, possibly multi-segment path whose every segment must itself be safe.
// Deliberately a lenient charset (not the narrow [A-Za-z0-9-]+ temp.ts uses for ITS keys, which
// are always machine-derived): SessionKey is a consumer-facing pinned type, so over-restricting
// what a caller may pass as projectKey/sessionId/subpath would be a Winter-only divergence the
// spec never asks for. What IS rejected is exactly WS-05 §6's list: empty, absolute, "..", and
// separator-escaping (double/trailing slashes) — never a specific character set.
// ---------------------------------------------------------------------------------------------

function assertSafeSingleSegment(value: string, label: string): void {
  if (value === "") throw new WinterStoreError(`${label} must not be empty`);
  if (value.includes("/")) throw new WinterStoreError(`${label} must not contain a path separator: ${JSON.stringify(value)}`);
  if (value === "." || value === "..") throw new WinterStoreError(`${label} must not be a traversal segment: ${JSON.stringify(value)}`);
}

function assertSafeSubpath(value: string): string[] {
  if (value === "") throw new WinterStoreError("subpath must not be empty");
  if (value.startsWith("/")) throw new WinterStoreError(`subpath must not be absolute: ${JSON.stringify(value)}`);
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "") {
      throw new WinterStoreError(`subpath must not contain empty segments (double/trailing separators): ${JSON.stringify(value)}`);
    }
    if (segment === "." || segment === "..") {
      throw new WinterStoreError(`subpath must not contain a traversal segment: ${JSON.stringify(value)}`);
    }
  }
  return segments;
}

function projectDir(winterHome: string, projectKey: string): string {
  return join(winterHome, "projects", projectKey);
}

// The session-level stem (no extension) — ALWAYS used for the lease/lock path, regardless of
// whether the actual read/write targets the main session or a subpath beneath it.
function sessionStem(winterHome: string, projectKey: string, sessionId: string): string {
  assertSafeSingleSegment(projectKey, "projectKey");
  assertSafeSingleSegment(sessionId, "sessionId");
  return join(projectDir(winterHome, projectKey), sessionId);
}

interface ResourceLocation {
  dirLevels: string[]; // every directory level to create/validate, top-down (append() only)
  stem: string; // the resource's own path with no extension — shared by .jsonl and .meta.json
}

function locateResource(winterHome: string, key: SessionKey): ResourceLocation {
  assertSafeSingleSegment(key.projectKey, "projectKey");
  assertSafeSingleSegment(key.sessionId, "sessionId");
  const projDir = projectDir(winterHome, key.projectKey);
  const dirLevels = [winterHome, join(winterHome, "projects"), projDir];

  if (key.subpath === undefined) {
    return { dirLevels, stem: join(projDir, key.sessionId) };
  }

  const segments = assertSafeSubpath(key.subpath);
  let current = join(projDir, key.sessionId);
  dirLevels.push(current); // the <sessionId>/ directory itself
  for (let i = 0; i < segments.length - 1; i++) {
    current = join(current, segments[i]!); // i < segments.length - 1, always in range
    dirLevels.push(current);
  }
  const stem = join(current, segments[segments.length - 1]!); // last segment is the file basename
  return { dirLevels, stem };
}

// ---------------------------------------------------------------------------------------------
// Directory security (mirrors paths/temp.ts's ensureValidatedDir posture, re-implemented here
// with WinterStoreError rather than reused: a store-surfaced failure should read as a store
// error, and the paths module's reuse contract for this task explicitly lists only
// resolveWinterHome/transcriptProjectKey/compatibilityKeys/sessionTempDir/ensureTasksDir — never
// its private directory-validation helper).
// ---------------------------------------------------------------------------------------------

function realUid(): number {
  return process.getuid!(); // POSIX-only, Bun-only + macOS-first runtime (Ruling P1-C) — see temp.ts
}

function ensureSecureDir(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (err) {
    if ((err as { code?: unknown }).code !== "EEXIST") throw err;
  }
  const stat = lstatSync(path); // lstat, never stat — a symlink (dangling or not) must be caught
  if (stat.isSymbolicLink()) throw new WinterStoreError(`refusing a symlink at a level the store must own: ${path}`);
  if (!stat.isDirectory()) throw new WinterStoreError(`expected a directory, found something else at: ${path}`);
  if (stat.uid !== realUid()) throw new WinterStoreError(`refusing a directory owned by a different uid: ${path}`);
  chmodSync(path, 0o700); // idempotent self-heal, umask-proof
}

// Write-path symlink hardening only (WS-05 §13: "never follow ... a symlink outside the owned
// session tree"). A followed READ symlink yields unparseable garbage — a contained, non-harmful
// failure — so load()/summary/meta reads deliberately stay plain readFileSync (matching the
// brief's scope; not swept here). A followed WRITE symlink could corrupt an arbitrary file the
// process can write to, which is the real risk, so every open that can MODIFY through a
// pre-existing path uses O_NOFOLLOW. Lock creation/steal and the meta/summary sidecars already
// avoid this a different way (O_EXCL / write-temp+rename never follow the destination), so this
// flag set is only needed for direct-append and truncate-in-place opens.
const APPEND_FLAGS = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW;
const RW_EXISTING_FLAGS = fsConstants.O_RDWR | fsConstants.O_NOFOLLOW;

function appendLinesAtomically(path: string, lines: string[]): void {
  const data = Buffer.from(
    lines.map((l) => l + "\n").join(""),
    "utf8",
  );
  const fd = openSync(path, APPEND_FLAGS, 0o600);
  try {
    writeAllSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600); // self-heal — a pre-existing file's mode isn't affected by the open() mode arg
}

function quarantineTornTail(jsonlPath: string, tornRaw: Buffer): void {
  const quarantinePath = `${jsonlPath}.tail-quarantine`;
  const fd = openSync(quarantinePath, APPEND_FLAGS, 0o600); // append — preserves history across repeated incidents
  try {
    writeAllSync(fd, tornRaw);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(quarantinePath, 0o600);
}

function repairTruncate(jsonlPath: string, keepBytes: number): void {
  const fd = openSync(jsonlPath, RW_EXISTING_FLAGS);
  try {
    ftruncateSync(fd, keepBytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeJsonAtomically(path: string, value: unknown): void {
  const data = Buffer.from(JSON.stringify(value), "utf8");
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const fd = openSync(tmpPath, "wx", 0o600); // fresh unique name — never a pre-existing symlink target
  try {
    writeAllSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path); // rename() replaces whatever dirent sits at `path` without following it
  chmodSync(path, 0o600);
}

function readJsonIfExists<T>(path: string): T | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt auxiliary sidecar (summary/metadata) is auxiliary data, not the source of truth
    // (the jsonl is) — WS-03 §11's "session-store failures are auxiliary, not fatal" posture:
    // treat as absent rather than blocking the caller on data that was never load-bearing.
    return null;
  }
}

function rmIfExists(path: string): void {
  try {
    rmSync(path);
  } catch (err) {
    if ((err as { code?: unknown }).code !== "ENOENT") throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Tail repair (WS-05 §13): a partial final line (no trailing "\n", OR newline-terminated but
// unparseable) is corruption requiring bounded repair — earlier valid entries are never dropped.
// Byte-precise (works over a Buffer, not a decoded string) so multi-byte UTF-8 content in an
// entry never shifts a truncation offset. Scoped to the FINAL line only, matching WS-05 §13's own
// "a partial final line" wording — a corrupt line elsewhere in the file is a different, out-of-
// scope failure mode this store does not attempt to self-heal.
// ---------------------------------------------------------------------------------------------

const NEWLINE = 0x0a;

interface TailRepairResult {
  entries: SessionStoreEntry[];
  torn: { raw: Buffer; keepBytes: number } | null;
}

function isParseableJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function decodeCompleteLines(buf: Buffer): SessionStoreEntry[] {
  if (buf.length === 0) return [];
  // Callers only ever pass a byte range ending exactly at a validated newline, so this always
  // ends in "\n" — the trailing "" from the final split is a guaranteed artifact, not data.
  const lines = buf.toString("utf8").split("\n");
  lines.pop();
  return lines.map((line) => JSON.parse(line) as SessionStoreEntry);
}

function parseWithTailRepair(buf: Buffer): TailRepairResult {
  if (buf.length === 0) return { entries: [], torn: null };

  const endsWithNewline = buf[buf.length - 1] === NEWLINE;

  if (endsWithNewline) {
    const searchEnd = buf.length - 2; // last index to search AT OR BEFORE, excluding the final byte
    const prevNL = searchEnd < 0 ? -1 : buf.lastIndexOf(NEWLINE, searchEnd);
    const lastLineStart = prevNL + 1;
    const lastLine = buf.subarray(lastLineStart, buf.length - 1).toString("utf8");
    if (isParseableJson(lastLine)) {
      return { entries: decodeCompleteLines(buf), torn: null };
    }
    const keepBytes = lastLineStart;
    const tornRaw = Buffer.from(buf.subarray(lastLineStart));
    return { entries: decodeCompleteLines(buf.subarray(0, keepBytes)), torn: { raw: tornRaw, keepBytes } };
  }

  // No trailing newline at all — the final line was never terminated.
  const lastNL = buf.lastIndexOf(NEWLINE);
  const keepBytes = lastNL + 1; // 0 when lastNL === -1 (the WHOLE file is one torn line)
  const tornRaw = Buffer.from(buf.subarray(keepBytes));
  return { entries: decodeCompleteLines(buf.subarray(0, keepBytes)), torn: { raw: tornRaw, keepBytes } };
}

// Collects every resource STEM under `dir` — a stem counts as present via EITHER its `.jsonl` or
// its `.meta.json` sidecar (a metadata-only subagent, per load()'s same fallback, has no jsonl at
// all yet is still a real, readable subkey — WS-05 §6 requires listSubkeys() for P4 materialization
// even for exactly that case). `out` is a Set so a subpath with BOTH files is reported once.
function walkResourceStems(dir: string, prefix: string, out: Set<string>): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return;
    throw err;
  }
  for (const dirent of entries) {
    const relPath = prefix === "" ? dirent.name : `${prefix}/${dirent.name}`;
    if (dirent.isDirectory()) {
      walkResourceStems(join(dir, dirent.name), relPath, out);
    } else if (dirent.isFile() && dirent.name.endsWith(".jsonl")) {
      out.add(relPath.slice(0, -".jsonl".length));
    } else if (dirent.isFile() && dirent.name.endsWith(".meta.json")) {
      out.add(relPath.slice(0, -".meta.json".length));
    }
  }
}

function foldSummary(summaryPath: string, sessionId: string, newEntries: SessionStoreEntry[]): void {
  const previous = readJsonIfExists<Partial<SessionSummaryEntry>>(summaryPath) ?? {};
  const lastEntry = newEntries[newEntries.length - 1]!; // guarded by newEntries.length > 0 at the call site
  const updated: SessionSummaryEntry = {
    ...previous,
    sessionId,
    entryCount: (previous.entryCount ?? 0) + newEntries.length,
    lastEntryType: lastEntry.type,
    ...(lastEntry.timestamp !== undefined ? { lastTimestamp: lastEntry.timestamp } : {}),
    mtime: Date.now(),
  };
  writeJsonAtomically(summaryPath, updated);
}

export class WinterCompatibilitySessionStore implements SessionStore {
  private readonly winterHome: string;

  constructor(opts: { winterHome: string }) {
    this.winterHome = opts.winterHome;
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return; // true no-op — touches nothing on disk, not even validation

    const { dirLevels, stem } = locateResource(this.winterHome, key);
    for (const level of dirLevels) ensureSecureDir(level);

    // Exclusive writer lease, scoped to (projectKey, sessionId) ONLY — never per-subpath.
    const lockPath = `${sessionStem(this.winterHome, key.projectKey, key.sessionId)}.lock`;
    acquireLease(lockPath);
    chmodSync(lockPath, 0o600);

    const jsonlPath = `${stem}.jsonl`;
    const metaPath = `${stem}.meta.json`;

    // agent_metadata envelopes are partitioned OUT of the native jsonl stream (WS-05 §6): only
    // the latest one survives, written atomically to the .meta.json sidecar; load() re-synthesizes
    // it after native entries. Every other entry is a normal native jsonl line.
    const nativeEntries: SessionStoreEntry[] = [];
    let latestMetadata: SessionStoreEntry | undefined;
    for (const e of entries) {
      if (e.type === "agent_metadata") {
        latestMetadata = e;
      } else {
        nativeEntries.push(e);
      }
    }

    if (nativeEntries.length > 0) {
      appendLinesAtomically(jsonlPath, nativeEntries.map((e) => JSON.stringify(e)));
    }
    if (latestMetadata !== undefined) {
      writeJsonAtomically(metaPath, latestMetadata);
    }
    if (key.subpath === undefined && nativeEntries.length > 0) {
      foldSummary(`${sessionStem(this.winterHome, key.projectKey, key.sessionId)}.summary.json`, key.sessionId, nativeEntries);
    }
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const { stem } = locateResource(this.winterHome, key); // validates the key even for a pure read
    const jsonlPath = `${stem}.jsonl`;
    const metaPath = `${stem}.meta.json`;

    let raw: Buffer | null;
    try {
      raw = readFileSync(jsonlPath);
    } catch (err) {
      if ((err as { code?: unknown }).code !== "ENOENT") throw err;
      raw = null;
    }

    if (raw === null) {
      // No native jsonl at all — but the key may still be KNOWN via a metadata-only append (a
      // subagent registered via its agent_metadata envelope before ever producing native output:
      // append() never creates a jsonl for a metadata-only batch). Only a sidecar with no jsonl
      // ever existing distinguishes this from a truly unknown key, which stays null.
      const meta = readJsonIfExists<SessionStoreEntry>(metaPath);
      return meta === null ? null : [meta];
    }

    const { entries, torn } = parseWithTailRepair(raw);
    if (torn !== null) {
      quarantineTornTail(jsonlPath, torn.raw);
      repairTruncate(jsonlPath, torn.keepBytes);
    }

    const meta = readJsonIfExists<SessionStoreEntry>(metaPath);
    if (meta !== null) entries.push(meta); // re-synthesized AFTER native entries

    return entries;
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    assertSafeSingleSegment(projectKey, "projectKey");
    const dir = projectDir(this.winterHome, projectKey);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      if ((err as { code?: unknown }).code === "ENOENT") return [];
      throw err;
    }
    const result: Array<{ sessionId: string; mtime: number }> = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue; // excludes .lock/.summary.json/.meta.json/.tail-quarantine and the bare <sessionId>/ subagent dir
      const full = join(dir, name);
      const stat = statSync(full);
      if (!stat.isFile()) continue;
      result.push({ sessionId: name.slice(0, -".jsonl".length), mtime: stat.mtimeMs });
    }
    return result;
  }

  async listSessionSummaries(projectKey: string): Promise<SessionSummaryEntry[]> {
    assertSafeSingleSegment(projectKey, "projectKey");
    const dir = projectDir(this.winterHome, projectKey);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      if ((err as { code?: unknown }).code === "ENOENT") return [];
      throw err;
    }
    const result: SessionSummaryEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(".summary.json")) continue;
      const parsed = readJsonIfExists<SessionSummaryEntry>(join(dir, name));
      if (parsed !== null) result.push(parsed);
    }
    return result;
  }

  async delete(key: SessionKey): Promise<void> {
    const { stem } = locateResource(this.winterHome, key);
    if (key.subpath === undefined) {
      // The explicit product deletion transaction (WS-05 §6): the ONLY place a cascade happens —
      // removes the flat main jsonl, every sidecar, AND the whole nested subagent tree (if any).
      // rmSync's recursive removal is inherently symlink-safe (WS-05 §13): it unlinks a symlink it
      // encounters rather than following it, so a planted symlink inside the tree can never cause
      // deletion of anything outside the owned session directory.
      rmIfExists(`${stem}.jsonl`);
      rmIfExists(`${stem}.jsonl.tail-quarantine`);
      rmIfExists(`${stem}.lock`);
      rmIfExists(`${stem}.summary.json`);
      rmIfExists(`${stem}.meta.json`);
      rmSync(stem, { recursive: true, force: true }); // the <sessionId>/ subagent directory, if present
    } else {
      // Targeted deletion of just one subkey resource — no cascade beyond it.
      rmIfExists(`${stem}.jsonl`);
      rmIfExists(`${stem}.jsonl.tail-quarantine`);
      rmIfExists(`${stem}.meta.json`);
    }
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const sessionDir = sessionStem(this.winterHome, key.projectKey, key.sessionId); // no extension = the directory itself
    const results = new Set<string>();
    walkResourceStems(sessionDir, "", results);
    return [...results];
  }
}
