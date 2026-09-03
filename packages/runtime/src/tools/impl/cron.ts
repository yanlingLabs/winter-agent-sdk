// WS-06 §3.4 "CronCreate/CronDelete/CronList" -- the real executors (Phase 3, Lane D / Task 6).
// Registers over the three stub descriptors descriptors/cron-{create,delete,list}.ts already in the
// registry. Schedules PROMPTS, never OS cron (no crontab/launchd touched anywhere in this file) --
// this module STORES and VALIDATES; actual firing (turning a stored job into a running prompt at the
// right wall-clock moment) is host/daemon behavior WS-06 §3.4 explicitly assigns to a later phase.
//
// --- The two stores ---------------------------------------------------------------------------
// `durable: false` (default) jobs live ONLY in a process-wide, module-level in-memory Map -- they do
// not survive a process restart, by design (matches "durable: true persists..."'s own implication
// that the default does NOT). `durable: true` jobs live ONLY in the project's own
// `.winter/scheduled_tasks.json` file (WS-01 §2.4 project dot-dir convention; "project dir" resolved
// as `ctx.cwd`, the one project-identity value ToolExecutionContext actually carries -- no
// repo-root-walking helper exists anywhere in this codebase today, verified before writing this) --
// re-read fresh on every CronList/CronDelete call rather than cached, so a durable job created by an
// EARLIER process in the same project directory is visible to a later one (the whole point of
// "durable" -- outliving this process), and so CronList/CronDelete never drift from the file's own
// ground truth. The two stores are never merged into one representation; CronList is the only place
// that concatenates their two job lists for display.
//
// *** T8 SCHEMA-SWEEP NOTES (report in task-6-report.md) ***
//   1. CronCreate's pinned result is "id, human schedule, recurring, durable?" -- `durable` carries
//      a `?` here (unlike CronList's own unconditional `durable` per-row field) -- read literally:
//      CronCreate OMITS `durable` from its result when the call used the default (false); it is
//      present (`durable: true`) only when the caller explicitly asked for persistence. `recurring`
//      has no `?` in CronCreate's own text -- always present, resolved-to-its-default value.
//   2. CronDelete's result shape is NOT pinned anywhere in WS-06 §3.4 prose (only the input,
//      `{id}`, and "by id only, never by expression"). Minimal honest choice: `{id, deleted}` -- an
//      echo of the requested id plus whether a job with that id was actually found and removed.
//      Deleting an unknown id is a normal, non-error outcome (`deleted: false`), mirroring
//      TaskGet's own "absence is a valid answer, not a failure" pattern elsewhere in this lane --
//      NOT an isError (contrast TaskUpdate's own targeted-mutation-of-an-unknown-id, which IS an
//      error: CronDelete's own contract explicitly frames "by id" as a lookup, not an assertion
//      that the id must already exist).
//   3. `humanSchedule` is DERIVED, never persisted -- computed fresh from the stored `cron` string
//      on every CronCreate/CronList call by `humanizeCron` below. This is a deliberately MODEST,
//      best-effort formatter (a handful of common shapes: every minute, every N minutes, hourly,
//      daily, weekly-on-a-day, monthly-on-a-day-of-month), not an attempt at full cron-to-English
//      parity -- WS-06 pins no exact wording anywhere, and a hand-rolled full natural-language cron
//      describer is a large, unbounded surface for a field with no pinned test oracle. Anything the
//      formatter does not recognize falls back to echoing the raw cron expression itself (honest,
//      never wrong, just unembellished).
//   4. Malformed pre-existing `.winter/scheduled_tasks.json` (bad JSON, or valid JSON that is not
//      the `{jobs: CronJobRecord[]}` envelope this module itself writes) is a hard, legible error on
//      every durable-touching call (create/delete/list) -- this module NEVER overwrites a file it
//      could not first parse successfully; a caller sees a specific "why" and the file is left byte-
//      for-byte untouched for a human to inspect.
//   5. Cron field grammar supported: `*`, a bare integer, a range `a-b`, a step `*/n` or `a-b/n`,
//      comma-separated lists of any of those, and (month/day-of-week fields only) the standard
//      3-letter English name tokens (JAN..DEC, SUN..SAT), case-insensitive. Rejected, with a legible
//      per-field error: named schedules (`@daily`, `@hourly`, ...), any field count other than
//      exactly 5 (no seconds field, no year field), out-of-range values, and empty fields/items.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, constants as fsConstants, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
// Self-sufficiency (Lane A precedent, read.ts): see task-graph.ts's identical comment.
import "../descriptors/index.ts";

export interface CronJobRecord {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
}

// --- Cron expression validation (five fields, local time; WS-06 §3.4) ------------------------------

interface FieldSpec {
  label: string;
  min: number;
  max: number;
  names?: Readonly<Record<string, number>>;
}

const MONTH_NAMES: Readonly<Record<string, number>> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DOW_NAMES: Readonly<Record<string, number>> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const FIELD_SPECS: readonly FieldSpec[] = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day-of-month", min: 1, max: 31 },
  { label: "month", min: 1, max: 12, names: MONTH_NAMES },
  { label: "day-of-week", min: 0, max: 7, names: DOW_NAMES },
];

function resolveToken(spec: FieldSpec, token: string): number {
  const named = spec.names?.[token.toLowerCase()];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(token)) {
    throw new Error(`${spec.label}: "${token}" is not a valid value (expected an integer${spec.names ? " or name" : ""} between ${spec.min} and ${spec.max})`);
  }
  const n = Number(token);
  if (n < spec.min || n > spec.max) {
    throw new Error(`${spec.label}: ${n} is out of range ${spec.min}-${spec.max} (got "${token}")`);
  }
  return n;
}

function validatePart(spec: FieldSpec, part: string): void {
  const stepSplit = part.split("/");
  if (stepSplit.length > 2) throw new Error(`${spec.label}: malformed step expression "${part}"`);
  const base = stepSplit[0]!;
  const stepRaw = stepSplit[1];
  if (stepRaw !== undefined && (!/^\d+$/.test(stepRaw) || Number(stepRaw) < 1)) {
    throw new Error(`${spec.label}: step must be a positive integer (got "${part}")`);
  }
  if (base === "*") return;
  const rangeParts = base.split("-");
  if (rangeParts.length === 1) {
    resolveToken(spec, rangeParts[0]!);
    return;
  }
  if (rangeParts.length === 2) {
    const lo = resolveToken(spec, rangeParts[0]!);
    const hi = resolveToken(spec, rangeParts[1]!);
    if (lo > hi) throw new Error(`${spec.label}: range start must not exceed end (got "${part}")`);
    return;
  }
  throw new Error(`${spec.label}: malformed value "${part}"`);
}

function validateField(spec: FieldSpec, raw: string): void {
  if (raw.length === 0) throw new Error(`${spec.label}: field is empty`);
  for (const part of raw.split(",")) {
    if (part.length === 0) throw new Error(`${spec.label}: empty item in comma-separated list (got "${raw}")`);
    validatePart(spec, part);
  }
}

// Throws a legible Error naming the offending field on any malformed input; returns void on success.
export function validateCronExpression(cron: string): void {
  const trimmed = cron.trim();
  if (trimmed.length === 0) throw new Error("cron expression is empty");
  if (trimmed.startsWith("@")) {
    throw new Error(`named schedules like "${trimmed.split(/\s+/)[0]}" are not supported -- use a five-field cron expression (minute hour day-of-month month day-of-week)`);
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`expected exactly 5 space-separated fields (minute hour day-of-month month day-of-week), got ${fields.length}: "${cron}"`);
  }
  fields.forEach((f, i) => validateField(FIELD_SPECS[i]!, f));
}

// --- Humanizer (T8 note 3 above: modest, best-effort, never wrong -- just sometimes unembellished) --

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

const DOW_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function humanizeCron(cron: string): string {
  const trimmed = cron.trim();
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return trimmed; // never called on an unvalidated expression, but stay honest if it ever is
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];

  if (minute === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "every minute";

  const everyNMatch = minute.match(/^\*\/(\d+)$/);
  if (everyNMatch && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `every ${everyNMatch[1]} minutes`;
  }

  const isPlainInt = (s: string): boolean => /^\d+$/.test(s);

  if (isPlainInt(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `hourly at minute ${minute}`;
  }

  if (isPlainInt(minute) && isPlainInt(hour) && dom === "*" && month === "*" && dow === "*") {
    return `daily at ${pad2(Number(hour))}:${pad2(Number(minute))}`;
  }

  if (isPlainInt(minute) && isPlainInt(hour) && dom === "*" && month === "*" && dow !== "*") {
    const dowNum = DOW_NAMES[dow.toLowerCase()] ?? (isPlainInt(dow) ? Number(dow) % 7 : undefined);
    if (dowNum !== undefined && DOW_LABELS[dowNum] !== undefined) {
      return `weekly on ${DOW_LABELS[dowNum]} at ${pad2(Number(hour))}:${pad2(Number(minute))}`;
    }
  }

  if (isPlainInt(minute) && isPlainInt(hour) && isPlainInt(dom) && month === "*" && dow === "*") {
    return `monthly on day ${dom} at ${pad2(Number(hour))}:${pad2(Number(minute))}`;
  }

  return trimmed; // honest fallback: no invented wording for a shape we don't specifically recognize
}

// --- Non-durable store: process-wide, in-memory --------------------------------------------------

const inMemoryJobs = new Map<string, CronJobRecord>();

// Test-only escape hatch (background-tasks.ts precedent).
export function resetInMemoryCronStoreForTest(): void {
  inMemoryJobs.clear();
}

// --- Durable store: `<projectDir>/.winter/scheduled_tasks.json`, re-read fresh every call ----------

interface DurableFile {
  jobs: CronJobRecord[];
}

function durableFilePath(projectDir: string): string {
  return join(projectDir, ".winter", "scheduled_tasks.json");
}

function isCronJobRecord(v: unknown): v is CronJobRecord {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["id"] === "string" &&
    typeof o["cron"] === "string" &&
    typeof o["prompt"] === "string" &&
    typeof o["recurring"] === "boolean" &&
    typeof o["durable"] === "boolean"
  );
}

// Never clobbers: throws (never silently starts fresh, never overwrites) the moment the file exists
// but cannot be parsed as this module's own envelope shape. Absence of the file (or of the .winter
// directory itself) is NOT an error -- it means "no durable jobs have ever been created here."
function readDurableJobs(projectDir: string): CronJobRecord[] {
  const path = durableFilePath(projectDir);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`could not read ${path}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path} contains malformed JSON, refusing to touch it: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as Record<string, unknown>)["jobs"])) {
    throw new Error(`${path} does not have the expected {jobs: [...]} shape, refusing to touch it`);
  }
  const jobs = (parsed as DurableFile).jobs;
  if (!jobs.every(isCronJobRecord)) {
    throw new Error(`${path} contains an entry that is not a valid scheduled-task record, refusing to touch it`);
  }
  return jobs;
}

// Whole-file atomic write: temp file in the SAME directory (so rename() is same-filesystem-atomic),
// fsync before rename, mode 0600 (project-local secrets-adjacent data -- a scheduled prompt string --
// owner-only by default). Mirrors the established permissions/auto/caches.ts writeAtomic precedent
// in this codebase (pid+counter temp name, O_CREAT|O_EXCL|O_NOFOLLOW, fsync, rename).
let tempCounter = 0;
function writeDurableJobsAtomic(projectDir: string, jobs: CronJobRecord[]): void {
  const path = durableFilePath(projectDir);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true }); // "create parents"
  const tmpPath = join(dir, `.scheduled_tasks.${process.pid}-${++tempCounter}.tmp`);
  const data = Buffer.from(JSON.stringify({ jobs } satisfies DurableFile, null, 2), "utf8");
  const fd = openSync(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written, data.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
}

// --- Input validation --------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface CronCreateInput {
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
}

function parseCreateInput(raw: unknown): CronCreateInput {
  if (!isPlainObject(raw)) throw new Error("input must be an object");
  const cron = raw["cron"];
  if (typeof cron !== "string" || cron.length === 0) throw new Error("cron must be a non-empty string");
  const prompt = raw["prompt"];
  if (typeof prompt !== "string" || prompt.length === 0) throw new Error("prompt must be a non-empty string");
  const recurring = raw["recurring"];
  if (recurring !== undefined && typeof recurring !== "boolean") throw new Error("recurring must be a boolean");
  const durable = raw["durable"];
  if (durable !== undefined && typeof durable !== "boolean") throw new Error("durable must be a boolean");
  validateCronExpression(cron); // throws a field-specific, legible error on malformed input
  return { cron, prompt, recurring: recurring ?? true, durable: durable ?? false };
}

function parseIdInput(raw: unknown): { id: string } {
  if (!isPlainObject(raw)) throw new Error("input must be an object");
  const id = raw["id"];
  if (typeof id !== "string" || id.length === 0) throw new Error("id must be a non-empty string");
  return { id };
}

function errorResult(message: string): ToolResultPayload {
  return { output: `Error: ${message}`, isError: true };
}

// --- CronCreate ----------------------------------------------------------------------------------

async function executeCreate(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  let input: CronCreateInput;
  try {
    input = parseCreateInput(rawInput);
  } catch (e) {
    return errorResult((e as Error).message);
  }
  const record: CronJobRecord = { id: randomUUID(), cron: input.cron, prompt: input.prompt, recurring: input.recurring, durable: input.durable };

  if (input.durable) {
    let existing: CronJobRecord[];
    try {
      existing = readDurableJobs(ctx.cwd);
    } catch (e) {
      return errorResult((e as Error).message);
    }
    try {
      writeDurableJobsAtomic(ctx.cwd, [...existing, record]);
    } catch (e) {
      return errorResult(`could not persist the durable job: ${(e as Error).message}`);
    }
  } else {
    inMemoryJobs.set(record.id, record);
  }

  // T8 note 1 above: `durable` omitted when false (the `?` in CronCreate's own pinned result list);
  // `recurring` always present.
  return {
    output: JSON.stringify({
      id: record.id,
      humanSchedule: humanizeCron(record.cron),
      recurring: record.recurring,
      ...(record.durable ? { durable: true } : {}),
    }),
  };
}

// --- CronDelete ------------------------------------------------------------------------------------

async function executeDelete(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  let input: { id: string };
  try {
    input = parseIdInput(rawInput);
  } catch (e) {
    return errorResult((e as Error).message);
  }

  if (inMemoryJobs.delete(input.id)) {
    return { output: JSON.stringify({ id: input.id, deleted: true }) };
  }

  let existing: CronJobRecord[];
  try {
    existing = readDurableJobs(ctx.cwd);
  } catch (e) {
    return errorResult((e as Error).message);
  }
  const remaining = existing.filter((j) => j.id !== input.id);
  if (remaining.length === existing.length) {
    // T8 note 2 above: unknown id is a normal, non-error outcome -- "by id only" is a lookup
    // contract, not an assertion that the id must already exist.
    return { output: JSON.stringify({ id: input.id, deleted: false }) };
  }
  try {
    writeDurableJobsAtomic(ctx.cwd, remaining);
  } catch (e) {
    return errorResult(`could not persist the deletion: ${(e as Error).message}`);
  }
  return { output: JSON.stringify({ id: input.id, deleted: true }) };
}

// --- CronList --------------------------------------------------------------------------------------

async function executeList(_rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  let durableJobs: CronJobRecord[];
  try {
    durableJobs = readDurableJobs(ctx.cwd);
  } catch (e) {
    return errorResult((e as Error).message);
  }
  const all = [...durableJobs, ...inMemoryJobs.values()];
  const jobs = all.map((j) => ({
    id: j.id,
    cron: j.cron,
    humanSchedule: humanizeCron(j.cron),
    prompt: j.prompt,
    recurring: j.recurring,
    durable: j.durable,
  }));
  return { output: JSON.stringify({ jobs }) };
}

// --- Wiring ----------------------------------------------------------------------------------------

replaceExecutor("CronCreate", { execute: executeCreate } satisfies ToolExecutor);
replaceExecutor("CronDelete", { execute: executeDelete } satisfies ToolExecutor);
replaceExecutor("CronList", { execute: executeList } satisfies ToolExecutor);
