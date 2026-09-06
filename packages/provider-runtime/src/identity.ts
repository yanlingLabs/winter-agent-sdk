// WS-13b: WINTER'S OWN IDENTITY ON EVERY WIRE.
//
// One function, one string, and the reason it is a module rather than a constant spread across five
// header builders is the rule it enforces: WS-13 §5 (reaffirmed by D21) says client-identity headers
// are NEVER imported and every Winter adapter authors its own. A per-family literal is five places a
// vendor's product name could later be pasted "just for compatibility"; one function is a place a
// reviewer can grep, and `identity.test.ts` is where the negative lives.
//
// It is deliberately NOT configurable. A host that could override it could make Winter present as an
// editor or a first-party CLI, which is the exact thing the admission rule exists to forbid. The one
// sanctioned override is a user's own `ConnectionProfile.headers` — that is the operator speaking
// about their own proxy, and it goes through `hostHeaders` like every other host header.
//
// SOURCE OF THE VERSION: this package's own `package.json` "version" field, which
// `scripts/sync-version.ts` restamps from the root VERSION file. A static JSON import (not a runtime
// fs read) because this module reaches the compiled `$bunfs` binary through production-wiring, and a
// relative fs read does not survive that — the catalog next door already ships as a static JSON
// import into the same binary, so this path is proven rather than assumed.

import pkg from "../package.json";

/**
 * `winter-agent-sdk/<version>` — the `User-Agent` every adapter family sends.
 *
 * Never an editor, a vendor CLI or a first-party product identity (WS-13 §5, D21). Where a vendor
 * names a second identity field (aihorde's `Client-Agent`, the codex backend's `originator`), that
 * field carries Winter's name too; it never carries somebody else's.
 */
export function winterUserAgent(): string {
  return `winter-agent-sdk/${pkg.version}`;
}
