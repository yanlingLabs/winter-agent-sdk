// `@yanlinglabs/winter-conformance/official` — the pinned-upstream mechanics (WS-02 §6), as an
// importable surface rather than a repo-relative script path (P7a Lane C, WS-02 §9 Step 2).
//
// Two independent halves, re-exported from their own modules:
//   `fetch.ts`   — checksum-verified ephemeral fetch of the pinned 0.3.250 wrapper tarball.
//   `capture.ts` — `runCapture()`, the RUN_OFFICIAL_CAPTURE=1-gated differential-signal harness that
//                  drives the real official SDK against loopback fakes. Calling `runCapture()`
//                  directly (as opposed to running `scripts/capture-official-golden.ts`) does NOT
//                  re-check the env gate — that gate is a CLI-boundary concern, not a property of
//                  the capture itself (mirrors WS-17's own "gate at the door, not in the room"
//                  convention for the opt-in live provider gate).
export { ChecksumMismatchError, OfficialCompatUnavailableError, fetchAndVerifyUpstream, getChecksums, resolveCacheDir, verifyDigest, verifySha512Integrity } from "./fetch.ts";
export { runCapture } from "./capture.ts";
// P7a fix wave r2 (item 3, re-review N1): `runCapture` is Bun-only (`Bun.spawn` + `Bun.serve`) and
// refuses with this typed error anywhere else, rather than a `ReferenceError` from inside it.
export { BunRequiredError, hasBunRuntime, requireBunRuntime } from "../bun-required.ts";
