// WS-25 spec §4.1 -- THE SIZE GATE: how large a value does `Bun.secrets` store and read back intact?
//
// OPT-IN, and off by default on purpose. This repository's rule is that no test reaches the real
// Keychain (`provider/keychain-store.ts`'s header and its repo-wide tripwire), and an ordinary `bun test`
// keeps that rule: this file is skipped unless `WINTER_TEST_KEYCHAIN_SIZE_GATE=1`. When it does run, it
// goes through `createKeychainRawStore` -- the one file allowed to name the backend -- on a THROWAWAY
// service (`com.winter.test.ws25-size-gate.<pid>`, never a `com.winter.core*` service that holds a user's
// real items), and deletes every item it wrote in `finally`.
//
// MEASURED (2026-09-27, macOS 26.6, bun 1.3): every size up to 4 MiB round-tripped byte-for-byte
// (1 KiB 207 ms incl. first access, 4 MiB ~325 ms); nothing threw and nothing truncated. The 4096-byte
// ceiling Claude Code documents is the `security -i` command line's, not the Keychain's.
//
// DECISION (spec §2): TWO items per server stay -- `mcp-oauth:<id>` (tokens; sessions read it) and
// `mcp-oauth-client:<id>` (the client registration, secret included; only the host reads it). Size does
// not force a single item, and the split is worth keeping for LEAST PRIVILEGE: a session's process
// never needs, and so never reads, a client secret.
//
// Run it: `WINTER_TEST_KEYCHAIN_SIZE_GATE=1 bun test packages/runtime/src/mcp-auth/size-gate.test.ts`
import { expect, test } from "bun:test";
import { createKeychainRawStore } from "../provider/keychain-store.ts";

const ENABLED = process.env.WINTER_TEST_KEYCHAIN_SIZE_GATE === "1";
const SIZES = [1024, 4096, 4097, 16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
/** Far above any real record: a JWT access token plus a refresh token is a few KiB. */
const REQUIRED_BYTES = 64 * 1024;

test.skipIf(!ENABLED)(
  "Bun.secrets round-trips every measured size intact on a throwaway service (spec §4.1)",
  async () => {
    const service = `com.winter.test.ws25-size-gate.${process.pid}`;
    expect(service.startsWith("com.winter.core")).toBe(false);
    const store = createKeychainRawStore(service);
    const results: Array<{ bytes: number; outcome: "intact" | "mismatch" | "threw" }> = [];
    const written: string[] = [];
    try {
      for (const bytes of SIZES) {
        const account = `size-gate-${bytes}`;
        // A non-repeating tail, so a truncation anywhere shows as a mismatch, not a coincidence.
        const value = `${"x".repeat(bytes - 12)}${String(bytes).padStart(12, "0")}`;
        try {
          written.push(account);
          await store.write(account, value);
          results.push({ bytes, outcome: (await store.read(account)) === value ? "intact" : "mismatch" });
        } catch {
          results.push({ bytes, outcome: "threw" });
        }
      }
    } finally {
      for (const account of written) await store.remove(account).catch(() => {});
    }
    console.log(`size gate: ${results.map((r) => `${r.bytes}=${r.outcome}`).join(" ")}`);
    const largestIntact = Math.max(0, ...results.filter((r) => r.outcome === "intact").map((r) => r.bytes));
    expect(largestIntact).toBeGreaterThanOrEqual(REQUIRED_BYTES);
    // Nothing below the largest intact size may have failed: a limit is a threshold, not a lottery.
    expect(results.filter((r) => r.bytes <= largestIntact && r.outcome !== "intact")).toEqual([]);
  },
  60_000,
);
