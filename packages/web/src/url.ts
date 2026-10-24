// WHAT CAN EVEN BE FETCHED -- the lexical rules applied to every hop before any network access.
//
// `http` is upgraded to `https` UNCONDITIONALLY, on every hop (a redirect to `http:` is upgraded
// too). Then three shapes are refused: a URL longer than 2000 characters, a URL carrying embedded
// credentials (userinfo), and a hostname with fewer than two dot-separated labels -- so `localhost`,
// every IPv6 literal (`[::1]` is one label) and any plain-http-only service are unfetchable whatever
// the private-address policy says. What a private target needs in order to be fetchable at all,
// under `privateAddressPolicy: "allow"`, is an `https` service on an IPv4 literal or on a name with
// two or more labels.

/** Why a parsed URL is refused before any network access. */
export type UnfetchableUrlReason = "too-long" | "embedded-credentials" | "single-label-hostname" | "unsupported-scheme";

/** The longest URL fetched. */
export const MAX_URL_LENGTH = 2000;

/** The `http:` -> `https:` upgrade. Returns `url` itself for any other scheme. */
export function upgradeToHttps(url: URL): URL {
  if (url.protocol !== "http:") return url;
  const upgraded = new URL(url.toString());
  upgraded.protocol = "https:";
  return upgraded;
}

/**
 * The fetch-time refusals for one already-parsed URL (overlong, embedded credentials, a hostname
 * with fewer than two labels). `undefined` means none applies. The scheme is NOT checked here --
 * see `unfetchableUrlReason`.
 */
export function fetchTimeUrlRefusal(url: URL): Exclude<UnfetchableUrlReason, "unsupported-scheme"> | undefined {
  if (url.toString().length > MAX_URL_LENGTH) return "too-long";
  if (url.username !== "" || url.password !== "") return "embedded-credentials";
  if (url.hostname.split(".").length < 2) return "single-label-hostname";
  return undefined;
}

/** Every reason a parsed URL will not be fetched, after the https upgrade, scheme included. */
export function unfetchableUrlReason(url: URL): UnfetchableUrlReason | undefined {
  const upgraded = upgradeToHttps(url);
  if (upgraded.protocol !== "https:") return "unsupported-scheme";
  return fetchTimeUrlRefusal(upgraded);
}

/** `url` as text with any userinfo removed -- the only form a message or a result ever carries. */
export function urlWithoutCredentials(url: URL): string {
  if (url.username === "" && url.password === "") return url.toString();
  const copy = new URL(url.toString());
  copy.username = "";
  copy.password = "";
  return copy.toString();
}
