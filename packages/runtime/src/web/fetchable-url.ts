// WHAT `WebFetch` CAN EVEN TRY TO FETCH -- the LEXICAL rules claude applies to a target before any
// network access, in ONE place, because two consumers must never disagree about them:
//
//   - `tools/impl/_web-fetch-net.ts`, the executor, which refuses on them (`Invalid URL`) as the
//     first thing it does per hop, ahead of the domain floor and ahead of the private-address policy;
//   - `permissions/evaluator.ts`, which must NOT raise an approval prompt -- nor suggest, nor let a
//     user save, a `WebFetch(domain:<host>)` rule -- for a target the executor is certain to refuse
//     anyway. That was a real mutual deferral between the two lanes (whole-branch review M2): the
//     permission layer asked about `http://localhost:5173/`, offered "always allow", saved a rule,
//     and every call still answered `Invalid URL`.
//
// A SHARED PREDICATE, NOT A SECOND COPY OF THE RULE. This module lives under `web/` (which registers
// no tool and imports no executor -- `tools/impl-isolation.test.ts` pins that) precisely so the
// permissions layer may import it without importing a tool implementation, which is the wrong
// direction of dependency.
//
// THE RULES ARE CLAUDE'S, kept as they are (the project's parity rule): claude upgrades `http` to
// `https` UNCONDITIONALLY and then rejects any URL longer than 2000 characters, any URL with embedded
// credentials, and any hostname with fewer than two dot-separated labels. So `localhost`, every IPv6
// literal (`[::1]` is one label) and a plain-http-only service are unfetchable in claude too. The
// consequence worth stating plainly, because three user-facing texts have to say it: what a private
// or loopback target needs in order to be fetchable at all is an `https` service on an IPv4 literal
// (`127.0.0.1`, four labels) or on a name the URL parser leaves with two or more labels
// (`printer.local`, `api.localhost`, and -- claude's behaviour too -- a trailing-dot `localhost.`).

/** claude's fetch-time rejects, as a reason a caller may name in a comment or a test. The TEXT the model sees is always `FETCH_TIME_INVALID_URL`. */
export type UnfetchableUrlReason = "too-long" | "embedded-credentials" | "single-label-hostname";

/** The three FETCH-TIME rejects' text: a bare `Invalid URL`, never the fuller parse-failure sentence (extraction-notes fidelity #2, corrected). */
export const FETCH_TIME_INVALID_URL = "Invalid URL";

/** The `http:` -> `https:` upgrade, unconditional and claude's own. Returns `url` itself for any other scheme. */
export function upgradeToHttps(url: URL): URL {
  if (url.protocol !== "http:") return url;
  const upgraded = new URL(url.toString());
  upgraded.protocol = "https:";
  return upgraded;
}

/**
 * claude's own fetch-time rejects for ONE already-parsed URL: overlong, embedded credentials, a
 * hostname with fewer than two dot-separated labels. `undefined` means none of them applies.
 *
 * Run PER HOP by the executor (claude runs it once on the raw input; running it again on every
 * upgraded hop is strictly stricter and is kept deliberately -- a disclosed, safe deviation).
 */
export function fetchTimeUrlRefusal(url: URL): UnfetchableUrlReason | undefined {
  if (url.toString().length > 2000) return "too-long";
  if (url.username !== "" || url.password !== "") return "embedded-credentials";
  if (url.hostname.split(".").length < 2) return "single-label-hostname";
  return undefined;
}

/**
 * Is this target one the executor is CERTAIN to refuse before it touches the network -- i.e. after
 * the https upgrade, does a fetch-time reject apply?
 *
 * The question the permission layer asks. It takes an already-parsed URL, so an UNPARSEABLE input is
 * outside this predicate entirely: such a call names no host, so no rule could be suggested or saved
 * for it, and its own refusal (`validateInput`'s parse-failure sentence) is a different text.
 */
export function isCertainlyUnfetchableUrl(url: URL): UnfetchableUrlReason | undefined {
  return fetchTimeUrlRefusal(upgradeToHttps(url));
}

/**
 * The one sentence every text about a private/loopback target ends with, so the ask, the rule hint
 * and the executor's own refusal all say the SAME true thing about what an approval can achieve.
 */
export const FETCHABLE_TARGET_SHAPE = "WebFetch upgrades http to https unconditionally, so only an https service at an IPv4 literal (127.0.0.1) or at a name with two or more dot-separated labels (printer.local) is reachable at all -- a plain-http port on localhost or an IPv6 literal cannot be fetched whatever the policy says.";
