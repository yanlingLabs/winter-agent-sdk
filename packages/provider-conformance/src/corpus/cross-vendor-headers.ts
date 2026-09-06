// P6.5 fix wave (ruling R-FW-1, whole-branch review I-1): THE CROSS-VENDOR HEADER RULE.
//
// WHY THIS IS A GENERAL RULE AND NOT AN xAI ASSERTION. The defect it exists to catch shipped past
// every denylist the branch had, because every one of them was written from the SAME vendor's
// fixture: `xai-oauth.test.ts` and `DERIVED_XAI.vendorOnlyHeaders` list xAI's own six header names,
// so a header named for a DIFFERENT vendor (`chatgpt-account-id`, authored by the dormant branch in
// the plain chat adapter and composed into `createXaiOauthAdapter`) was invisible to all of them. A
// same-vendor fixture can only ever see the vendor it was written from; this rule is keyed on the
// row's OWN identity instead, so it sees every other vendor at once.
//
// THE RULE. A request header whose name begins with a vendor's product prefix may appear only on a
// request to a row that vendor owns. `chatgpt-account-id` on `codex-oauth` is honest — it names the
// operator's account at the backend it was minted for. The same header on `xai-oauth` is another
// vendor's product header, holding an account-scoped (R6-L privileged) value, on a request Winter
// makes under its own name.
//
// EXEMPTIONS ARE BY NAME, NEVER BY PREFIX, and that distinction is the whole design. A dialect is
// not an identity: `deepseek-anthropic` speaks the Anthropic MESSAGES protocol and cannot be spoken
// to without `anthropic-version`, which `endpoint-policy.ts` itself classifies as PROTOCOL ("headers
// EVERY endpoint needs to be spoken to at all, and which carry no cross-endpoint meaning:
// `content-type`, `accept`, `anthropic-version`, `anthropic-beta` …") rather than privileged. So the
// four dialect siblings carry an `anthropic-` name legitimately — and exempting the two protocol
// names does NOT exempt `anthropic-organization`, or any other `anthropic-` name a future edit might
// add. Exempting the whole prefix would have re-opened the hole this rule closes.

import type { RecordedRequest } from "../fakes/server.ts";

/**
 * The vendor product prefixes this rule polices, and the Winter provider ids each vendor owns.
 *
 * The prefix list is the ruling's (R-FW-1). The OWNER lists are read off the catalog's own rows: a
 * prefix's owners are the ids whose vendor authored the header namespace, so `openai-` is honest on
 * OpenAI's own row and on the codex backend (an OpenAI surface), and on nothing else.
 */
export const CROSS_VENDOR_HEADER_OWNERS: Readonly<Record<string, readonly string[]>> = {
  "chatgpt-": ["codex-oauth"],
  "openai-": ["openai", "codex-oauth"],
  "anthropic-": ["anthropic"],
  "x-goog-": ["google", "vertex"],
  "x-grok-": ["xai", "xai-oauth"],
  "x-xai-": ["xai", "xai-oauth"],
  "x-amz-": ["bedrock"],
};

/**
 * Header names that are the DIALECT's protocol, exempt on every row served by that adapter.
 *
 * Keyed by `adapterId` rather than by provider id, because the exemption is a property of the wire
 * protocol a row speaks and not of the vendor it belongs to — which is exactly why a third party's
 * `<id>-anthropic` sibling needs it and a third party's own OpenAI-dialect row does not.
 *
 * Each entry is one of the names `endpoint-policy.ts` enumerates as PROTOCOL. Nothing account-scoped
 * or organisation-scoped belongs here; those are the names the rule exists to catch.
 */
export const DIALECT_PROTOCOL_HEADERS: Readonly<Record<string, readonly string[]>> = {
  // The Anthropic Messages dialect. `anthropic-version` is mandatory on every request and
  // `anthropic-beta` carries the protocol opt-ins (the D20 OAuth beta among them).
  "winter.anthropic-messages": ["anthropic-version", "anthropic-beta"],
  // The codex backend's Responses surface "cannot be spoken to without" `OpenAI-Beta`
  // (`codex-oauth.ts`'s own words). `codex-oauth` also OWNS the `openai-` prefix above; this entry
  // is what would keep the protocol header honest if that ownership were ever narrowed.
  "winter.codex-oauth": ["openai-beta"],
};

export interface CrossVendorSweepTarget {
  /** The Winter row the request was made for. */
  providerId: string;
  /** The adapter that served it — the key the dialect-protocol exemption is read by. */
  adapterId: string;
}

/**
 * Every cross-vendor violation in one header map, as readable sentences.
 *
 * Returns `[]` for a clean request. The strings name the header, the row and the vendor whose
 * namespace it is, because a bare boolean on a header sweep is a failure nobody can act on.
 *
 * VALUES ARE NEVER INCLUDED. A violating header is by definition account- or organisation-scoped,
 * and a failure message is one of the most reliably-pasted strings in any system.
 */
export function crossVendorHeaderViolations(target: CrossVendorSweepTarget, headers: Record<string, string>): string[] {
  const exempt = new Set((DIALECT_PROTOCOL_HEADERS[target.adapterId] ?? []).map((name) => name.toLowerCase()));
  const out: string[] = [];
  for (const rawName of Object.keys(headers)) {
    const name = rawName.toLowerCase();
    if (exempt.has(name)) continue;
    for (const [prefix, owners] of Object.entries(CROSS_VENDOR_HEADER_OWNERS)) {
      if (!name.startsWith(prefix)) continue;
      if (owners.includes(target.providerId)) continue;
      out.push(`${target.providerId} (${target.adapterId}) sent ${JSON.stringify(name)}, a "${prefix}" header owned by ${owners.join("/")}`);
    }
  }
  return out;
}

/** The same sweep over a fake's whole recorded request log. One call per driven row. */
export function crossVendorViolationsIn(target: CrossVendorSweepTarget, requests: readonly RecordedRequest[]): string[] {
  return requests.flatMap((recorded) => crossVendorHeaderViolations(target, recorded.headers));
}
