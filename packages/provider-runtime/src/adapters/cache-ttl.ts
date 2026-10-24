// 0.0.56 (W3): per-marker prompt-cache lifetimes, shared by the two adapters that place Anthropic
// `cache_control` breakpoints -- the Anthropic Messages adapter and the Chat Completions adapter for an
// Anthropic model routed through OpenRouter (W1).
//
// THREE MARKERS, THREE LIFETIMES. `TurnRequest.cacheTtl` has set the SYSTEM breakpoints' lifetime since
// WS-23; `TurnRequest.messageCacheTtl` now sets the two message-level breakpoints' too: the ROLLING one on
// the request's tail and the LOOKBACK one on the previous request's write. A 1-hour lifetime is written
// at twice the input price and survives a long idle gap.
//
// THE ORDER RULE, refused rather than "fixed". Anthropic: "cache entries with longer TTL must appear
// before shorter TTLs" -- a 1-hour breakpoint after a 5-minute one is an invalid request
// (https://platform.claude.com/docs/en/build-with-claude/prompt-caching#mixing-different-ttls). The wire
// order is system, then lookback, then rolling, so the lifetimes must not INCREASE along it. A request
// that asks otherwise is refused here, typed (`bad_request`), before a byte is sent -- the same
// treatment this layer gives a thinking budget that does not fit (refuse a shape the vendor would 400,
// never silently send a different one). Silently shortening a marker the host asked to keep for an hour
// would quietly change its cost and its cache behaviour.
//
// The rule is checked on the DECLARED lifetimes, not only on the breakpoints a given request happens to
// place: the lookback marker appears only once a conversation has grown past the lookback window, and a
// configuration that is valid on turn 3 and refused on turn 40 is not one a host can test. The one
// exception is a system prompt that carries no breakpoint at all (no `systemBlocks`, or every block's
// scope `null`): it is not on the wire, so it constrains nothing.
import { ProviderRequestError } from "../http.ts";
import type { TurnRequest } from "../types.ts";

export type CacheTtl = "5m" | "1h";

/** The lifetime of each breakpoint a request may place. */
export interface ResolvedCacheTtls {
  system: CacheTtl;
  lookback: CacheTtl;
  rolling: CacheTtl;
}

const RANK: Record<CacheTtl, number> = { "5m": 0, "1h": 1 };

function isTtl(value: unknown): value is CacheTtl {
  return value === "5m" || value === "1h";
}

function refusal(message: string): ProviderRequestError {
  return new ProviderRequestError({ code: "bad_request", message, retryable: false });
}

/**
 * The request's breakpoint lifetimes, or a typed refusal.
 *
 * Absent values are the provider's default, 5 minutes -- except the LOOKBACK marker, which defaults to
 * the ROLLING marker's lifetime: it sits exactly on the block the previous request's rolling marker
 * wrote, so it names that same entry.
 *
 * @param systemMarked whether the request carries at least one system breakpoint.
 */
export function resolveCacheTtls(req: Pick<TurnRequest, "cacheTtl" | "messageCacheTtl">, systemMarked: boolean): ResolvedCacheTtls {
  if (req.cacheTtl !== undefined && !isTtl(req.cacheTtl)) throw refusal(`cacheTtl must be "5m" or "1h", got ${JSON.stringify(req.cacheTtl)}`);
  const message = req.messageCacheTtl;
  if (message !== undefined && (typeof message !== "object" || message === null)) throw refusal("messageCacheTtl must be an object { rolling?, lookback? }");
  if (message?.rolling !== undefined && !isTtl(message.rolling)) throw refusal(`messageCacheTtl.rolling must be "5m" or "1h", got ${JSON.stringify(message.rolling)}`);
  if (message?.lookback !== undefined && !isTtl(message.lookback)) throw refusal(`messageCacheTtl.lookback must be "5m" or "1h", got ${JSON.stringify(message.lookback)}`);
  const system: CacheTtl = req.cacheTtl ?? "5m";
  const rolling: CacheTtl = message?.rolling ?? "5m";
  const lookback: CacheTtl = message?.lookback ?? rolling;
  if (RANK[lookback] < RANK[rolling]) {
    throw refusal(`the lookback cache breakpoint (${lookback}) comes before the rolling one (${rolling}), and a longer lifetime must come before a shorter one -- set messageCacheTtl.lookback to "${rolling}" or leave it unset`);
  }
  if (systemMarked && RANK[system] < RANK[lookback]) {
    throw refusal(`the system prompt's cache breakpoints (${system}) come before the message breakpoints (${lookback}), and a longer lifetime must come before a shorter one -- set cacheTtl to "1h" too, or shorten messageCacheTtl`);
  }
  return { system, lookback, rolling };
}

/** The wire `cache_control` object for one lifetime: the 5-minute default carries no `ttl` field, exactly as before. */
export function cacheControlFor(ttl: CacheTtl): { type: "ephemeral"; ttl?: "1h" } {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}
