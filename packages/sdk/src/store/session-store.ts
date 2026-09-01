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
//
// Task 8 EXTENDS this (never removes the mechanical fields above) with the dialect writer's
// Winter-private producer/dialect metadata (WS-05 §5.4, narrowed to what P1 needs — the full
// TranscriptDialectRecord shape there is later-task scope). Delivered via DIALECT_RECORD_ENTRY_TYPE
// below, never a transcript line; optional because a summary folded before Task 8 (or any plain,
// non-dialect append) may not carry them.
//
// Task 9 extends it again with `projectDirName` — Ruling P1-N's persisted half (WS-05 §3.2): the
// resolved (WINTER_PROJECT_DIR_NAME-overridden, or default) directory name this session is actually
// stored under, so a later resume prefers this recorded value over a fresh env resolution rather
// than guessing from the CURRENT environment (dialect.ts's resolveEngineSession).
//
// Task 10 extends it once more with `name`/`tags` — WS-03 §3.1's own words: "metadata (name, tags)
// is application-facing storage API, not an implementation artifact." Written by the standalone
// session-management API's renameSession/tagSession (../sessions.ts) via mergeSessionMetadata
// below; first-classed here (rather than left to the `[key: string]: unknown` index signature)
// following the exact precedent Tasks 8/9 set for their own sidecar extensions.
export type SessionSummaryEntry = {
  sessionId: string;
  entryCount: number;
  mtime: number;
  lastEntryType?: string;
  lastTimestamp?: string;
  producerRuntime?: "claude-agent" | "winter-agent";
  producerEngineVersion?: string;
  dialectFamily?: "claude-code-jsonl";
  projectDirName?: string;
  name?: string;
  tags?: string[];
  [key: string]: unknown;
};

// Task 8: a reserved SessionStoreEntry.type recognized by append() alongside "agent_metadata" —
// its fields are folded into the summary sidecar (see foldSummary) and it is NEVER written to the
// jsonl or returned by load(). dialect.ts (packages/runtime/src/store/dialect.ts) is the only
// intended producer; exported so it never hand-copies the string.
export const DIALECT_RECORD_ENTRY_TYPE = "winter_dialect_record";

// WS-03 §10 pins this as EXACTLY these six members — Task 9 fix-round 1 (MAJOR finding) reverted an
// earlier `listProjectKeys?()` addition here after review: exports.json's lack of field-level detail
// for SessionStore is not license to widen the pinned surface, only silence about it. The
// project-enumeration capability resume.ts's findResumeTarget needs for WS-05 §7's "then every other
// project" fallback stays SOLELY on the concrete WinterCompatibilitySessionStore class below
// (see its own listProjectKeys method) — resume.ts accesses it through a local intersection type,
// never through this exported type.
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

// Task 8: `dialectExtra` (when given) is the DIALECT_RECORD_ENTRY_TYPE entry's own fields, minus
// its `type` discriminator — folded in ALONGSIDE the mechanical fields below, never replacing them.
// Spread order is load-bearing: `...previous` first (so anything not touched this call — dialect
// fields included — survives untouched), then `...dialectExtra` (a fresh dialect record always
// wins over a stale previous one), then the mechanical fields LAST and unconditionally (they must
// never be shadowed by a caller-supplied `dialectExtra`, even a maliciously/accidentally colliding
// one — hence computing `mechanical` into its own object rather than trusting spread order alone
// across three sources). `newEntries` can be empty here (a dialect-only append, append()'s guard
// allows calling this with zero native entries) — guarded so a dialect-only fold neither derefs a
// nonexistent lastEntry nor bumps entryCount/lastEntryType/lastTimestamp for entries that don't
// exist.
function foldSummary(
  summaryPath: string,
  sessionId: string,
  newEntries: SessionStoreEntry[],
  dialectExtra?: Record<string, unknown>,
): void {
  const previous = readJsonIfExists<Partial<SessionSummaryEntry>>(summaryPath) ?? {};
  const mechanical: Partial<SessionSummaryEntry> = {};
  if (newEntries.length > 0) {
    const lastEntry = newEntries[newEntries.length - 1]!;
    mechanical.entryCount = (previous.entryCount ?? 0) + newEntries.length;
    mechanical.lastEntryType = lastEntry.type;
    if (lastEntry.timestamp !== undefined) mechanical.lastTimestamp = lastEntry.timestamp;
  }
  // `dialectExtra`'s values are runtime-arbitrary (Record<string, unknown> — append() partitions it
  // generically, without statically knowing dialect.ts's specific field names) — an `as` cast here
  // mirrors readJsonIfExists's own "trust the runtime shape" cast just above in this file, rather
  // than fighting exactOptionalPropertyTypes over an assignment TS cannot verify structurally.
  const updated = {
    ...previous,
    ...dialectExtra,
    sessionId,
    ...mechanical,
    mtime: Date.now(),
  } as SessionSummaryEntry;
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
    // it after native entries. Task 8's DIALECT_RECORD_ENTRY_TYPE is partitioned the same way, but
    // never written anywhere on its own — its fields (minus the `type` discriminator) are folded
    // into the summary sidecar below instead (WS-05 §5.2: Winter-private metadata is never a
    // transcript line). Every other entry is a normal native jsonl line.
    const nativeEntries: SessionStoreEntry[] = [];
    let latestMetadata: SessionStoreEntry | undefined;
    let dialectExtra: Record<string, unknown> | undefined;
    for (const e of entries) {
      if (e.type === "agent_metadata") {
        latestMetadata = e;
      } else if (e.type === DIALECT_RECORD_ENTRY_TYPE) {
        const { type: _type, ...fields } = e;
        dialectExtra = fields;
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
    // Summary folding (mechanical fields AND the dialect record) is main-key only — a subpath key
    // (a subagent transcript) has no summary sidecar of its own (WS-05 §6), so a dialect-record
    // entry sent on a subpath key is partitioned out of its jsonl above and then silently dropped
    // here, same as it would be for any other summary-only metadata on a subkey.
    if (key.subpath === undefined && (nativeEntries.length > 0 || dialectExtra !== undefined)) {
      foldSummary(`${sessionStem(this.winterHome, key.projectKey, key.sessionId)}.summary.json`, key.sessionId, nativeEntries, dialectExtra);
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

  // Task 9, Winter-only extension — deliberately NOT part of the exported SessionStore type (see
  // its own comment above; fix-round 1 reverted an earlier attempt to declare it there). Lives ONLY
  // here, on the concrete class — a real TS class is free to carry members beyond what an interface
  // it implements requires, so `this instanceof WinterCompatibilitySessionStore` callers (main.ts,
  // testing.ts, resume.ts's local intersection cast) can still reach it while `store: SessionStore`
  // parameters correctly see only the pinned six. Every top-level directory directly under
  // <winterHome>/projects/, i.e. every known projectKey. No mtime/sort guarantee, matching
  // listSessions' own "order not guaranteed" contract.
  async listProjectKeys(): Promise<string[]> {
    const dir = join(this.winterHome, "projects");
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as { code?: unknown }).code === "ENOENT") return [];
      throw err;
    }
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  // Task 10, Winter-only extension — same posture as listProjectKeys above: deliberately NOT part
  // of the exported SessionStore type (WS-03 §10 pins exactly six members), lives ONLY on the
  // concrete class. A minimal store addition (flagged in task-10-report.md) so the standalone
  // session-management API's renameSession/tagSession (../sessions.ts) can merge caller-supplied
  // metadata into the summary sidecar under the SAME writer lease + atomic-write discipline
  // append()/foldSummary already use for that exact file — rather than a second,
  // independently-implemented read-modify-write in a different module racing the real one.
  // Lease-guarded (unlike a bare read+writeJsonAtomically) because foldSummary's own read-modify-
  // write only ever runs already inside append()'s held lease — an unleased merge here could lose
  // an update raced against a live engine session actively appending to the same summary file.
  // `patch`'s own conditional keys naturally implement "only touch the field being set" (an
  // omitted field spreads nothing, leaving `...previous`'s value for it untouched) — callers pass
  // exactly one of `name`/`tags` per call today, but this merges any combination correctly.
  async mergeSessionMetadata(key: { projectKey: string; sessionId: string }, patch: { name?: string; tags?: string[] }): Promise<void> {
    const stem = sessionStem(this.winterHome, key.projectKey, key.sessionId);
    const lockPath = `${stem}.lock`;
    acquireLease(lockPath);
    chmodSync(lockPath, 0o600);

    const summaryPath = `${stem}.summary.json`;
    const previous = readJsonIfExists<Partial<SessionSummaryEntry>>(summaryPath) ?? {};
    const updated = {
      ...previous,
      ...patch,
      sessionId: key.sessionId,
      mtime: Date.now(),
    } as SessionSummaryEntry;
    writeJsonAtomically(summaryPath, updated);
  }
}
