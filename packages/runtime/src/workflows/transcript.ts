// Phase 5 fix wave (known item A-14): the RUN TRANSCRIPT -- what `WorkflowOutput.transcriptDir`
// actually points at.
//
// WHAT WAS WRONG. `runtime.ts` created the directory (so a model reading the reported path got an
// empty directory rather than ENOENT) and nothing ever wrote into it. The brief's choice was "write
// the run transcript there, or stop creating and reporting it -- pick and pin". `transcriptDir` is a
// field of the CAPTURED `WorkflowOutput` (derived-shapes-p5 item (g)), so dropping it is not
// available: the honest half is to write the transcript.
//
// WHAT IT IS NOT. It is not the child agents' transcripts. Those are written by
// `subagents/child-engine.ts`, wherever that module puts them, and this lane may not move them --
// which is exactly the disclosure `runtime.ts` already carried. This is the RUN's own record:
// launch, every `agent()` call and its outcome, phase changes, and the terminal state.
//
// WHY IT IS NOT THE JOURNAL. The journal (journal.ts) is a RESUME CACHE: session-temp, keyed by
// prompt, and it deliberately records SUCCESSFUL calls only (WS-11 §1.5) -- so a run whose agents
// all came back null leaves an empty one, which is precisely the case WS-11 §1.8's "first
// diagnostic surface for empty/unexpected results" is about. The transcript records every call,
// including the null ones, and lives in the durable session area the model was handed.
//
// EVERY WRITE IS BEST-EFFORT. A transcript that could fail a run would be worse than no transcript:
// this is a diagnostic, and `runtime.ts`'s own terminal states must not depend on a filesystem that
// might be full or read-only.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-field byte cap. The full values live elsewhere -- an agent's result in the journal and in the
 * child's own transcript, the run's result in the task output file -- so this file bounds what a
 * long-running workflow can write into the durable projects area. 2 KB keeps a prompt and a result
 * legible at a glance, which is what a diagnostic surface is for.
 */
export const TRANSCRIPT_FIELD_MAX_BYTES = 2048;

const TRUNCATION_MARKER = "… [truncated]";

/** UTF-8 byte cap on a byte boundary -- `skills/frontmatter.ts`'s `capBytes`, same rule, same reason. */
function capField(value: string): string {
  const buf = Buffer.from(value, "utf8");
  return buf.byteLength <= TRANSCRIPT_FIELD_MAX_BYTES ? value : buf.subarray(0, TRANSCRIPT_FIELD_MAX_BYTES).toString("utf8") + TRUNCATION_MARKER;
}

/** A string passes through; anything else is JSON. Then capped. Mirrors `renderResult`'s rule so the two surfaces agree. */
function renderCapped(value: unknown): string {
  return capField(typeof value === "string" ? value : JSON.stringify(value ?? null));
}

export type WorkflowTranscriptEntry =
  | { kind: "launch"; runId: string; name: string; scriptPath: string; args?: string; resumedFrom?: string; replayed?: number }
  | { kind: "agent"; prompt: string; outcome: "value" | "null"; value?: string; phase?: string; label?: string }
  | { kind: "phase"; title: string; declared: boolean }
  | { kind: "finish"; status: "completed" | "failed" | "stopped"; detail?: string };

/**
 * One run's transcript: append-only NDJSON at `<transcriptDir>/transcript.jsonl`.
 *
 * The directory is created by the caller (`runtime.ts` creates and reports it in the same breath),
 * so this class only appends -- and swallows every error, per this module's header.
 */
export class RunTranscript {
  private readonly path: string;

  constructor(transcriptDir: string) {
    this.path = join(transcriptDir, "transcript.jsonl");
  }

  append(entry: WorkflowTranscriptEntry): void {
    try {
      appendFileSync(this.path, JSON.stringify({ at: Date.now(), ...entry }) + "\n", { mode: 0o600 });
    } catch {
      /* a diagnostic must never fail the run it is describing -- this module's own header */
    }
  }

  /** The `agent()` record, with the value rendered and capped here so callers never do it twice. */
  agent(input: { prompt: string; value: unknown; resolvedNull: boolean; phase?: string; label?: string }): void {
    this.append({
      kind: "agent",
      prompt: capField(input.prompt),
      outcome: input.resolvedNull ? "null" : "value",
      ...(input.resolvedNull ? {} : { value: renderCapped(input.value) }),
      ...(input.phase !== undefined ? { phase: capField(input.phase) } : {}),
      ...(input.label !== undefined ? { label: capField(input.label) } : {}),
    });
  }

  finish(status: "completed" | "failed" | "stopped", detail?: string): void {
    this.append({ kind: "finish", status, ...(detail !== undefined ? { detail: capField(detail) } : {}) });
  }
}

export { capField as capTranscriptField, renderCapped as renderTranscriptValue };
