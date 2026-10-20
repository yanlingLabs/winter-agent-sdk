import { expect, test } from "bun:test";
import { linuxEndedBootEvidence, linuxRecordContinuationValid, linuxResumeSelectorMatches, type ContinuationRecord } from "./linux-cold-resume.ts";
import type { ProtectedStoreScope } from "./store-bootstrap.ts";

const BOOT = "11111111-1111-4111-8111-111111111111", OLD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OLDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const scope = { workspaceId: "w", sessionId: "backend", incarnationId: "i", leaseEpoch: 2, storeHome: "/workspace/.winter/conversations/l", currentBootId: BOOT } as ProtectedStoreScope;
const record = (over: Record<string, unknown> = {}): ContinuationRecord & { scope: ProtectedStoreScope } => ({ profile: "host-query-v1", continuation: "fresh", endedGuestBoots: [], scope, ownerToken: "tok", runtimeConfig: {}, ...over }) as never;
const resume = (over: Record<string, unknown> = {}) => record({ continuation: "resume", runtimeConfig: { resume: "backend" }, ...over });

test("the fixture profile stays fresh-only and carries neither cold-resume key", () => {
  expect(linuxRecordContinuationValid(record({ profile: undefined, continuation: undefined, endedGuestBoots: undefined, freshOnly: true }))).toBe(true);
  for (const over of [{ freshOnly: undefined }, { freshOnly: false }, { continuation: "fresh" }, { endedGuestBoots: [] }, { continuation: "resume" }]) {
    expect(linuxRecordContinuationValid(record({ profile: undefined, continuation: undefined, endedGuestBoots: undefined, freshOnly: true, ...over })), JSON.stringify(over)).toBe(false);
  }
});

test("a host-query record is fresh or resume, closed: `either` is the supervisor's to resolve, never the record's", () => {
  expect(linuxRecordContinuationValid(record())).toBe(true);
  expect(linuxRecordContinuationValid(record({ freshOnly: true }))).toBe(true);
  expect(linuxRecordContinuationValid(resume())).toBe(true);
  for (const continuation of ["either", "", "Fresh", "RESUME", null, 1, true, {}, []]) expect(linuxRecordContinuationValid(record({ continuation })), String(continuation)).toBe(false);
});

test("the legacy form (freshOnly true, no continuation) is fresh and nothing more", () => {
  const legacy = { continuation: undefined, endedGuestBoots: undefined, freshOnly: true };
  expect(linuxRecordContinuationValid(record(legacy))).toBe(true);
  for (const over of [{ freshOnly: undefined }, { freshOnly: false }, { endedGuestBoots: [] }, { runtimeConfig: { resume: "backend" } }]) expect(linuxRecordContinuationValid(record({ ...legacy, ...over })), JSON.stringify(over)).toBe(false);
});

test("resume requires the config to name the conversation's own session; fresh admits no resume; a resume carries no freshOnly", () => {
  for (const runtimeConfig of [{}, { resume: "foreign" }, { resume: "" }, { resume: undefined }]) expect(linuxRecordContinuationValid(resume({ runtimeConfig })), JSON.stringify(runtimeConfig)).toBe(false);
  expect(linuxRecordContinuationValid(record({ runtimeConfig: { resume: "backend" } }))).toBe(false);
  expect(linuxRecordContinuationValid(resume({ freshOnly: true }))).toBe(false);
  expect(linuxRecordContinuationValid(record({ freshOnly: "true" }))).toBe(false);
});

test("endedGuestBoots: 0 to 4 distinct canonical boot ids, never this boot", () => {
  const more = ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];
  expect(linuxRecordContinuationValid(resume({ endedGuestBoots: [OLD] }))).toBe(true);
  expect(linuxRecordContinuationValid(resume({ endedGuestBoots: [OLD, OLDER, ...more] }))).toBe(true);
  for (const endedGuestBoots of [[OLD, OLDER, ...more, "66666666-6666-4666-8666-666666666666"], [OLD, OLD], [BOOT], [OLD, BOOT], [OLD.toUpperCase()], ["not-a-boot"], [""], [1], [null], [`${OLD} `], [`${OLD}\n`], OLD, undefined, null, {}]) {
    expect(linuxRecordContinuationValid(resume({ endedGuestBoots })), JSON.stringify(endedGuestBoots)).toBe(false);
    expect(linuxRecordContinuationValid(record({ endedGuestBoots })), JSON.stringify(endedGuestBoots)).toBe(false);
  }
});

test("previous-boot evidence exists exactly for a host-attested boot that is not this one", () => {
  const value = resume({ endedGuestBoots: [OLD, OLDER] });
  expect(linuxEndedBootEvidence(value, OLD)).toEqual({ scope, ownerToken: "tok", previousBootId: OLD });
  expect(linuxEndedBootEvidence(value, OLDER)?.previousBootId).toBe(OLDER);
  // A boot the host never listed reads as alive, so the lease logic refuses; this boot is never "previous".
  expect(linuxEndedBootEvidence(value, "44444444-4444-4444-8444-444444444444")).toBeNull();
  expect(linuxEndedBootEvidence(value, BOOT)).toBeNull();
  expect(linuxEndedBootEvidence(resume({ endedGuestBoots: [BOOT] }), BOOT)).toBeNull();
  expect(linuxEndedBootEvidence(resume({ endedGuestBoots: [] }), OLD)).toBeNull();
  expect(linuxEndedBootEvidence(record({ profile: undefined, continuation: undefined, endedGuestBoots: undefined, freshOnly: true }), OLD)).toBeNull();
  for (const bad of ["", " " + OLD, OLD + " ", OLD.toUpperCase(), 1 as never, undefined as never]) expect(linuxEndedBootEvidence(value, bad), String(bad)).toBeNull();
  expect(linuxEndedBootEvidence(resume({ endedGuestBoots: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }), OLD)).toBeNull();
});

test("the evidence is bound to this record's scope and owner token, and its scope is a frozen copy", () => {
  const evidence = linuxEndedBootEvidence(resume({ endedGuestBoots: [OLD] }), OLD)!;
  expect(evidence.ownerToken).toBe("tok");
  expect(evidence.scope).toEqual(scope);
  expect(evidence.scope).not.toBe(scope);
  expect(Object.isFrozen(evidence.scope)).toBe(true);
});

test("the admitted config carries exactly the record's resume selector", () => {
  expect(linuxResumeSelectorMatches({}, {})).toBe(true);
  expect(linuxResumeSelectorMatches({ resume: "backend" }, { resume: "backend" })).toBe(true);
  expect(linuxResumeSelectorMatches({}, { resume: "backend" })).toBe(false);
  expect(linuxResumeSelectorMatches({ resume: "backend" }, {})).toBe(false);
  expect(linuxResumeSelectorMatches({ resume: "backend" }, { resume: "foreign" })).toBe(false);
});

test("the admission wires these rules and nothing weaker (static pins)", async () => {
  const text = await Bun.file(new URL("./linux-session-admission.ts", import.meta.url)).text();
  expect(text).toContain("!linuxRecordContinuationValid(record)");
  expect(text).toContain("previousBootTermination: bootId => linuxEndedBootEvidence(record, bootId)");
  expect(text).toContain("record.profile !== undefined && !linuxResumeSelectorMatches(fixed, config)");
  expect(text).not.toContain("previousBootTermination: () => null");
  expect(text).not.toMatch(/record\.freshOnly !== true/);
});
