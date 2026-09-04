// WS-10 §7: "the roster rebuilds from durable storage" -- a parent session keeps NO in-memory
// record of its own children that survives a process restart (each child is a live, in-process
// object -- child-engine.ts's own `spawnChildEngine`'s closures, nothing more). Each child's own
// `.meta.json` sidecar (WS-05 §5.3/§6, written by TranscriptWriter.writeMetadata at every
// settle()/spawn) is the only durable record of it. This module rebuilds a parent's own roster of
// ChildSessionRecords from that storage on resume.
//
// Deliberately data-only: this does NOT rehydrate a live, resumable `ChildHandle` for any of these
// records. Doing that needs the SAME construction-time `Provider`/`SessionStore` dependencies
// child-engine.ts's own `createChildEngineFactory` takes (Disclosed Gap #1's identical root cause --
// nothing reachable from a plain "rebuild the roster" call site carries either), so a genuinely
// LIVE, resume()-after-restart-capable child handle is a real second entry point this lane does not
// build here -- disclosed as a follow-up in this lane's own report, not attempted.
import type { SessionStore } from "@yanlinglabs/winter-agent-sdk";
import { listChildAgentIds, childTranscriptSubpath, TranscriptWriter } from "../store/dialect.ts";
import type { ChildSessionRecord } from "./child-handle.ts";

export interface RosterKey {
  projectKey: string;
  sessionId: string; // the PARENT session's own id
}

// One child's own rebuilt record, or a legible reason it could not be rebuilt (an unreadable/
// corrupted transcript, or a transcript with no metadata sidecar at all -- e.g. hand-edited or
// deleted out of band). Never thrown: one bad child's own storage must never prevent the REST of a
// parent's roster from rebuilding.
//
// Fix round 1 (finding I4): `reconciled: "orphaned"` marks a record whose OWN sidecar still said
// `status: "running"` at rebuild time -- WS-10 §7's own "rebuild child identity AND resume state"
// MUST, for the one case that only arises on restart: a child whose daemon died mid-run has no live
// handle behind it (this whole module's own header) and, left as `"running"`, is PERMANENTLY
// stranded -- `ChildHandle.resume()` (child-engine.ts) refuses any non-terminal record, so nothing
// could ever move it forward again. `record.status` itself is reconciled to `"stopped"` (the
// frozen `ChildSessionRecord` type, T3's, has no field of its own for "why" a status changed, so
// that marker lives here, on THIS module's own wrapper, not invented on the frozen record) --
// `"stopped"` reads truer than `"failed"` (the child's own work did not fail; its own PROCESS died
// out from under it), and is one of the three terminal statuses `resume()` already accepts.
export type RosterEntry = { ok: true; record: ChildSessionRecord; reconciled?: "orphaned" } | { ok: false; agentId: string; reason: string };

function isPlausibleChildSessionRecord(v: unknown): v is ChildSessionRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r["id"] === "string" && typeof r["parentSessionId"] === "string" && typeof r["parentToolUseId"] === "string" && typeof r["status"] === "string";
}

// Enumerates every child agentId known under a parent session (`listChildAgentIds`, WS-05 §6) and
// rebuilds each one's `ChildSessionRecord` from its own `.meta.json` sidecar. `store.load()`
// (session-store.ts) re-synthesizes AT MOST ONE `agent_metadata`-typed entry per child (the sidecar
// holds a single, wholesale-replaced JSON object -- TranscriptWriter.writeMetadata's own contract),
// appended after any native transcript entries, so no "which one wins" ambiguity exists.
export async function rebuildChildRoster(store: SessionStore, key: RosterKey): Promise<RosterEntry[]> {
  const agentIds = await listChildAgentIds(store, key);
  const out: RosterEntry[] = [];
  for (const agentId of agentIds) {
    const childKey = { projectKey: key.projectKey, sessionId: key.sessionId, subpath: childTranscriptSubpath(agentId) };
    try {
      const entries = await TranscriptWriter.readBack(store, childKey);
      const metadata = entries.find((e) => e.type === "agent_metadata");
      if (metadata === undefined) {
        out.push({ ok: false, agentId, reason: `child ${agentId} has a transcript but no agent_metadata sidecar -- cannot rebuild its record` });
        continue;
      }
      const { type: _type, ...record } = metadata;
      if (!isPlausibleChildSessionRecord(record)) {
        out.push({ ok: false, agentId, reason: `child ${agentId}'s agent_metadata sidecar is missing required fields -- treating as corrupted` });
        continue;
      }
      if (record.status === "running") {
        out.push({ ok: true, record: { ...record, status: "stopped" }, reconciled: "orphaned" });
        continue;
      }
      out.push({ ok: true, record });
    } catch (err) {
      out.push({ ok: false, agentId, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

// Convenience narrowing for a caller that only wants WS-10 §7's own "roster" itself (the
// successfully-rebuilt records) -- the failures above stay worth surfacing separately, so a caller
// that cares WHY a child is missing calls rebuildChildRoster directly instead of this helper.
export function successfulRecords(entries: RosterEntry[]): ChildSessionRecord[] {
  return entries.filter((e): e is Extract<RosterEntry, { ok: true }> => e.ok).map((e) => e.record);
}
