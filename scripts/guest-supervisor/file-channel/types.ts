/** Test stand-in for winter's packages/core/src/cowork/types.ts: only what the copied guest-file-channel.ts imports. The copy beside this file
 * is winter's merged grammar byte for byte (hash-pinned by test_file_browse.py); this stub is the one thing that differs from winter. */
export type CoworkErrorCode = "authority_denied" | "invalid_request" | "response_too_large" | "file_missing" | "file_unavailable" | "stale_file" | "file_incomplete";
export class CoworkError extends Error {
  constructor(readonly code: CoworkErrorCode) { super(code); this.name = "CoworkError"; }
}
// winter compiles against ES2024; this repo's lib is ES2022. Bun implements the method; only its declaration is missing here.
declare global { interface String { isWellFormed(): boolean } }
