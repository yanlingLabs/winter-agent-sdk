/** Differential driver for test_file_browse.py. Reads one JSON document on stdin and answers every case with what winter's channel grammar (the
 * hash-pinned copy beside this file) decides: request lines through parseCoworkGuestFileRequest, the guest's response lines through
 * parseCoworkGuestFileResponse against their request, and the grammar's literal tables. It opens no socket and spawns nothing. */
import { COWORK_GUEST_FILE_CHANNEL_VERSION, COWORK_GUEST_FILE_ERROR_CODES, COWORK_GUEST_FILE_LIMITS, COWORK_GUEST_FILE_OPERATIONS, COWORK_GUEST_FILE_REQUEST_KEYS,
  COWORK_GUEST_FILE_RESPONSE_KEYS, parseCoworkGuestFileRequest, parseCoworkGuestFileResponse } from "./guest-file-channel.ts";
import { CoworkError } from "./types.ts";

interface Case { kind: "request" | "response"; line: string; request?: string }
const input = JSON.parse(await Bun.stdin.text()) as { cases: Case[] };
const results = input.cases.map(item => {
  try {
    if (item.kind === "request") return { ok: true, value: parseCoworkGuestFileRequest(item.line) };
    const parsed = parseCoworkGuestFileResponse(item.line, parseCoworkGuestFileRequest(item.request));
    const value: Record<string, unknown> = { ...parsed };
    if ("content" in parsed) value.content = Buffer.from(parsed.content).toString("base64");
    return { ok: true, value };
  } catch (error) { return { ok: false, code: error instanceof CoworkError ? error.code : "thrown" }; }
});
const literals = { version: COWORK_GUEST_FILE_CHANNEL_VERSION, operations: COWORK_GUEST_FILE_OPERATIONS, errorCodes: COWORK_GUEST_FILE_ERROR_CODES,
  requestKeys: COWORK_GUEST_FILE_REQUEST_KEYS, responseKeys: COWORK_GUEST_FILE_RESPONSE_KEYS, limits: COWORK_GUEST_FILE_LIMITS };
console.log(JSON.stringify({ results, literals }));
