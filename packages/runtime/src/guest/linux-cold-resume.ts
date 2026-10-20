/** Cold resume (CR2): the pure record rules. Nothing here can mint a native admission; it only judges the root-sent record. */
import type { PreviousBootTerminationEvidence, ProtectedStoreScope } from "./store-bootstrap.ts";

export const LINUX_ENDED_BOOT_LIMIT = 4;
export const LINUX_BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The slice of the bootstrap record these rules read. */
export interface ContinuationRecord {
  profile?: string; freshOnly?: unknown; continuation?: unknown; endedGuestBoots?: unknown;
  scope: Pick<ProtectedStoreScope, "sessionId" | "currentBootId">; ownerToken: string; runtimeConfig: { resume?: unknown };
}

/** The fixture profile is fresh-only and carries neither new key. A host-query record carries a closed `continuation` and the
 * host-attested ended boots (0 to 4 distinct boot ids, never this boot). A resume names its own session in the config and carries no
 * `freshOnly`; a fresh record may still carry `freshOnly: true`, which the unmodified native owner requires until its proposed patch lands.
 * A record with no `continuation` at all is the legacy fresh form (`freshOnly: true`, no ended boots, no resume). */
export function linuxRecordContinuationValid(record: ContinuationRecord): boolean {
  if (record.profile === undefined) return record.freshOnly === true && record.continuation === undefined && record.endedGuestBoots === undefined;
  if (record.continuation === undefined) return record.freshOnly === true && record.endedGuestBoots === undefined && record.runtimeConfig.resume === undefined;
  if (record.continuation !== "fresh" && record.continuation !== "resume") return false;
  if (record.freshOnly !== undefined && (record.freshOnly !== true || record.continuation !== "fresh")) return false;
  const ended = record.endedGuestBoots;
  if (!Array.isArray(ended) || ended.length > LINUX_ENDED_BOOT_LIMIT || new Set(ended).size !== ended.length) return false;
  if (ended.some(boot => typeof boot !== "string" || !LINUX_BOOT_ID.test(boot) || boot === record.scope.currentBootId)) return false;
  return record.continuation === "resume" ? record.runtimeConfig.resume === record.scope.sessionId : record.runtimeConfig.resume === undefined;
}

/** Previous-boot evidence exactly when the host attested that boot as ended and it is not this boot; a guest-written marker never counts. */
export function linuxEndedBootEvidence(record: ContinuationRecord & { scope: ProtectedStoreScope }, bootId: string): PreviousBootTerminationEvidence | null {
  const ended = record.endedGuestBoots;
  if (!Array.isArray(ended) || typeof bootId !== "string" || bootId === record.scope.currentBootId || !ended.includes(bootId)) return null;
  return { scope: Object.freeze({ ...record.scope }), ownerToken: record.ownerToken, previousBootId: bootId };
}

/** The admitted config's `resume` must be exactly the record's: absent on a fresh record, the conversation's own session on a resume. */
export function linuxResumeSelectorMatches(fixed: { resume?: unknown }, config: { resume?: unknown }): boolean { return fixed.resume === config.resume; }
