// WS-09 §2/§7/§8.1: the unbranded MCP/Tool-Search env knobs, parsed ONCE from a given env record
// with EXACT value semantics pinned here -- so Lane A (Task 4)/Lane B (Task 5)/Task 3 consume one
// typed, tested shape instead of each re-parsing raw process.env strings with possibly-diverging
// edge-case handling (R4-2's whole reason for existing). Takes an explicit env record rather than
// reading `process.env` itself so tests (and a future caller that wants to parse a snapshot rather
// than the live environment) pass a plain fixture object instead of mutating the real process
// environment.
//
// Unbranded spellings kept VERBATIM (WS-01 §2.5): ENABLE_TOOL_SEARCH, MCP_CONNECTION_NONBLOCKING,
// MCP_CONNECT_TIMEOUT_MS, MCP_TIMEOUT, MCP_DISCOVERY_CACHE, MCP_TOOL_TIMEOUT, MAX_MCP_OUTPUT_TOKENS.
//
// "Garbage degrades to the documented default" posture throughout: an env var present but spelled
// wrong (case, typo, non-numeric where a number is expected) never throws or crashes runtime
// startup -- it resolves exactly as if the variable were absent. This mirrors the family's own
// framing (WS-09 §8.1's "unset" row is itself a real, spec-named value, not an error state) and
// avoids a malformed operator-set env var taking down a whole session over what is, for every one of
// these controls, a tuning knob rather than a correctness-critical input. Case-sensitivity for the
// string-valued controls is NOT verified against a live 0.3.250 runtime (CAPTURE-PENDING, R4-8
// class) -- recorded in task-2-report.md.
import type { DeferralActivation } from "../tools/registry.ts";

// Reuses registry.ts's OWN field type rather than redeclaring a second literal union that could
// drift from it (a producer/consumer mismatch this exact class of bug is what R4-2 exists to catch).
export type EnableToolSearchValue = DeferralActivation["enableToolSearch"];

export interface McpEnvConfig {
  enableToolSearch: EnableToolSearchValue;
  // WS-09 §2 table: "(startup) | nonblocking | ordinary servers connect in the background" /
  // "MCP_CONNECTION_NONBLOCKING=0 | unset (nonblocking) | forces startup to wait". `true` = the
  // default nonblocking behavior; `false` = the startup-blocking override.
  connectionNonblocking: boolean;
  connectTimeoutMs: number;
  timeoutMs: number;
  // WS-09 §2 table: "off by default (was on before CC 2.1.238; gradual rollout may enable) ...
  // MCP_DISCOVERY_CACHE=1". WS-09 §12 Open Question 2: Winter pins the explicit-env behavior only
  // and treats any server-side rollout default as out of conformance scope -- this parser can only
  // ever see the explicit env value, never a rollout state, so it always resolves to the pinned
  // "off unless set" default per that Open Question's own resolution.
  discoveryCache: boolean;
  // WS-09 §2 table's own Default column reads "--" (no documented default) -- absent, not defaulted
  // to any particular number, when the env var is unset or unparseable.
  toolTimeoutMs?: number;
  maxOutputTokens: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000; // WS-09 §2 table
const DEFAULT_TIMEOUT_MS = 30000; // WS-09 §2 table
const DEFAULT_MAX_OUTPUT_TOKENS = 25000; // WS-09 §7 (R4-8 capture-pending default)

function parseEnableToolSearch(raw: string | undefined): EnableToolSearchValue {
  if (raw === undefined) return "unset";
  if (raw === "true" || raw === "false" || raw === "auto") return raw;
  const match = /^auto:(\d+(?:\.\d+)?)$/.exec(raw);
  if (match) {
    const n = Number(match[1]);
    if (Number.isFinite(n)) return { auto: n };
  }
  // An unrecognized spelling (wrong case, typo, stray whitespace, a non-numeric auto: suffix)
  // degrades to "unset" rather than throwing -- see this file's own header.
  return "unset";
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

function parseOptionalPositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.trunc(n);
}

export function parseMcpEnvConfig(env: Readonly<Record<string, string | undefined>>): McpEnvConfig {
  const toolTimeoutMs = parseOptionalPositiveInt(env.MCP_TOOL_TIMEOUT);
  return {
    enableToolSearch: parseEnableToolSearch(env.ENABLE_TOOL_SEARCH),
    // WS-09 §2 table literal: the ONLY documented value that flips the nonblocking default is the
    // exact string "0" -- every other value (including unset) keeps the default.
    connectionNonblocking: env.MCP_CONNECTION_NONBLOCKING !== "0",
    connectTimeoutMs: parsePositiveInt(env.MCP_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS),
    timeoutMs: parsePositiveInt(env.MCP_TIMEOUT, DEFAULT_TIMEOUT_MS),
    // WS-09 §2 table literal: ONLY the exact string "1" turns the cache on.
    discoveryCache: env.MCP_DISCOVERY_CACHE === "1",
    ...(toolTimeoutMs !== undefined ? { toolTimeoutMs } : {}),
    maxOutputTokens: parsePositiveInt(env.MAX_MCP_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS),
  };
}
