// Phase 5 Lane W (task 4), WS-11 §1.5/§1.8: the per-run journal -- `journal.jsonl`, one directory
// per run. Ported from Norma's `workflows/journal.ts`.
//
// WHAT IT IS FOR, in two sentences: `resumeFromRunId` replays a prior run's UNCHANGED prefix of
// `agent()` calls from cache and goes live from the first changed or new one, and this file is that
// cache. It is also, per WS-11 §1.8, "the first diagnostic surface for empty/unexpected results" --
// it records each agent's ACTUAL return value, so an author staring at an empty workflow result can
// read what the agents really said.
//
// WRITTEN PARENT-SIDE, ALWAYS. The worker runs under a `(deny file-write*)` seatbelt and could not
// append here if it wanted to; the runtime appends after each successful bridged `agent()` call.
// That is not a limitation being worked around -- it is what keeps the journal trustworthy, since
// the untrusted script cannot forge or truncate its own resume cache.
//
// FAILURES ARE NEVER JOURNALED (WS-11 §1.5: "Only successful results are journaled -- failures
// re-run live"). The caller enforces that; this class simply appends what it is given.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentOpts } from "./types.ts";

export interface JournalEntry {
  promptKey: string;
  value: unknown;
}

/**
 * The positional cache key: `(prompt, opts)` serialized. WS-11 §1.5's "a per-run journal keyed by
 * call order + prompt/opts key" -- the ORDER is the array index, this is the identity check at that
 * index. `undefined` opts normalize to `null` so `agent("go")` and `agent("go", undefined)` are the
 * same call, which they are.
 */
export function promptKey(prompt: string, opts?: AgentOpts): string {
  return JSON.stringify([prompt, opts ?? null]);
}

export class RunJournal {
  private readonly path: string;

  constructor(dir: string, runId: string) {
    const runDir = join(dir, runId);
    mkdirSync(runDir, { recursive: true });
    this.path = join(runDir, "journal.jsonl");
  }

  append(promptKeyValue: string, value: unknown): void {
    this.appendRaw(JSON.stringify({ promptKey: promptKeyValue, value }) + "\n");
  }

  /** Escape hatch for the corrupt-line test -- a real caller always uses `append`. */
  appendRaw(line: string): void {
    appendFileSync(this.path, line);
  }

  /**
   * The journal's readable prefix. A missing file is an empty array (a fresh run has no journal),
   * and a CORRUPT line is skipped rather than fatal: a run killed mid-append leaves a partial last
   * line, and refusing to resume at all because of it would be strictly worse than resuming the
   * complete entries that precede it. The positional replay in script-api.ts diverges at the first
   * key mismatch anyway, so a skipped line can only ever shorten the cached prefix, never
   * misalign it -- a dropped middle entry shifts the entries after it, and the very next key
   * comparison fails and latches `diverged`, sending everything from there on live.
   */
  load(): JournalEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const out: JournalEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as JournalEntry;
        if (typeof parsed?.promptKey === "string") out.push(parsed);
      } catch {
        /* a partial final line from a killed run -- see the doc comment */
      }
    }
    return out;
  }
}
