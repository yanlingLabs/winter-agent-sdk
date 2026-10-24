// ADDRESS CLASSIFICATION -- what `privateAddressPolicy: "deny"` refuses.
//
// One rule, applied to bytes rather than to spellings: every address is parsed into its 4 or 16
// bytes first, and only the bytes are classified. A regex over the text form is how embeddings slip
// through (`::ffff:7f00:1`, `0:0:0:0:0:ffff:127.0.0.1`, `64:ff9b::a9fe:a9fe` all spell a private
// IPv4 address), so there is none here.
//
// IPv4: everything outside the public unicast space is refused -- 0/8, 10/8, 100.64/10 (CGNAT, which
// also holds the 100.100.100.200 metadata address some clouds use), 127/8, 169.254/16 (link-local,
// 169.254.169.254 metadata), 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15,
// 198.51.100/24, 203.0.113/24, 224/4 (multicast) and 240/4 (reserved, broadcast included).
//
// IPv6: public means inside 2000::/3 (the only block IANA allocates for global unicast) and outside
// its special-purpose carve-outs. The forms that EMBED an IPv4 address are classified by the address
// they embed: IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), IPv4-translated
// (::ffff:0:0:0/96), NAT64 (64:ff9b::/96), 6to4 (2002::/16, the address in bits 16-47) and Teredo
// (2001::/32: both the server and the de-obfuscated client address). 64:ff9b:1::/48 (local-use
// NAT64), fc00::/7 (unique-local, fd00:ec2::254 metadata included), fe80::/10, fec0::/10, ff00::/8,
// 100::/64, 2001:db8::/32, 3fff::/20 and the ORCHID blocks are refused outright.
//
// Hostnames: an IPv4 literal in ANY notation the classic `inet_aton` accepts (decimal `2130706433`,
// octal `0177.0.0.1`, hex `0x7f.1`, short forms `127.1`) is parsed and classified like the
// canonical form -- the WHATWG URL parser normalises these already, but a classifier that relied on
// its caller having done so would be one refactor away from a bypass. `localhost`, `*.localhost`,
// `local` and `*.local` are private by NAME, whatever they resolve to. A host carrying an IPv6 zone
// id (`%`) is never classified as public.
//
// Every address assigned to one of this machine's own interfaces is refused too: a public address
// bound locally still reaches the local machine's own ports.
import { networkInterfaces } from "node:os";

/** Why an address is not public. Stable strings: safe to show a model or a user. */
export type AddressRefusalReason =
  | "unspecified"
  | "loopback"
  | "private"
  | "cgnat"
  | "link-local"
  | "site-local"
  | "unique-local"
  | "multicast"
  | "broadcast"
  | "reserved"
  | "documentation"
  | "benchmarking"
  | "local-nat64"
  | "not-global-unicast"
  | "local-interface"
  | "reserved-name"
  | "zone-id"
  | "unparseable";

export type AddressVerdict = { public: true } | { public: false; reason: AddressRefusalReason; embedded?: string };

const PUBLIC: AddressVerdict = { public: true };

function refuse(reason: AddressRefusalReason, embedded?: string): AddressVerdict {
  return embedded === undefined ? { public: false, reason } : { public: false, reason, embedded };
}

// --- parsing ---------------------------------------------------------------------------------------

/**
 * Strict dotted-quad IPv4 (four decimal parts 0-255, no leading zeros), the only form a resolver
 * returns and the only form `net.isIP` accepts. `undefined` for anything else.
 */
export function parseIPv4(text: string): Uint8Array | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i]!;
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(p)) return undefined;
    const n = Number(p);
    if (n > 255) return undefined;
    out[i] = n;
  }
  return out;
}

function parseIPv4Part(part: string): number | undefined {
  if (part.length === 0) return undefined;
  let n: number;
  if (/^0x[0-9a-f]*$/i.test(part)) n = part.length === 2 ? 0 : parseInt(part.slice(2), 16);
  else if (/^0[0-7]+$/.test(part)) n = parseInt(part.slice(1), 8);
  else if (/^0[0-9]+$/.test(part)) return undefined; // "08": not octal, not decimal -- inet_aton refuses it
  else if (/^[0-9]+$/.test(part)) n = parseInt(part, 10);
  else return undefined;
  return Number.isSafeInteger(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * Every IPv4 notation `inet_aton` (and the WHATWG URL host parser) accepts: one to four parts, each
 * decimal, octal (`0` prefix) or hex (`0x` prefix), the last part filling the remaining bytes, one
 * trailing dot allowed. `undefined` when `text` is not such a literal; an out-of-range part also
 * answers `undefined` (the URL parser refuses those hosts outright).
 */
export function parseIPv4Loose(text: string): Uint8Array | undefined {
  let t = text;
  if (t.endsWith(".")) t = t.slice(0, -1);
  if (t.length === 0) return undefined;
  const parts = t.split(".");
  if (parts.length > 4) return undefined;
  const nums: number[] = [];
  for (const part of parts) {
    const n = parseIPv4Part(part);
    if (n === undefined) return undefined;
    nums.push(n);
  }
  const last = nums.pop()!;
  for (const n of nums) if (n > 255) return undefined;
  const lastBytes = 4 - nums.length;
  if (last >= 2 ** (8 * lastBytes)) return undefined;
  const out = new Uint8Array(4);
  nums.forEach((n, i) => (out[i] = n));
  let rest = last;
  for (let i = 3; i >= nums.length; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return out;
}

/** An IPv6 address (brackets allowed, no zone id) as 16 bytes, an embedded dotted quad included. `undefined` otherwise. */
export function parseIPv6(text: string): Uint8Array | undefined {
  let t = text;
  if (t.startsWith("[") && t.endsWith("]")) t = t.slice(1, -1);
  if (t.length === 0 || t.length > 45 || t.includes("%") || !t.includes(":")) return undefined;
  // An embedded dotted quad may close the address: it stands for the last two 16-bit groups.
  let v4: Uint8Array | undefined;
  const lastColon = t.lastIndexOf(":");
  if (t.slice(lastColon + 1).includes(".")) {
    v4 = parseIPv4(t.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    t = t.slice(0, lastColon + 1);
    if (!t.endsWith("::")) t = t.slice(0, -1);
  }
  const groups = (s: string): number[] | undefined => {
    if (s.length === 0) return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return undefined;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const capacity = v4 === undefined ? 8 : 6;
  const words: number[] = [];
  const double = t.indexOf("::");
  if (double !== -1) {
    if (t.indexOf("::", double + 1) !== -1) return undefined;
    const head = groups(t.slice(0, double));
    const rest = groups(t.slice(double + 2));
    if (head === undefined || rest === undefined || head.length + rest.length > capacity - 1) return undefined;
    words.push(...head, ...new Array<number>(capacity - head.length - rest.length).fill(0), ...rest);
  } else {
    const all = groups(t);
    if (all === undefined || all.length !== capacity) return undefined;
    words.push(...all);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < words.length; i++) {
    out[i * 2] = words[i]! >> 8;
    out[i * 2 + 1] = words[i]! & 0xff;
  }
  if (v4 !== undefined) out.set(v4, 12);
  return out;
}

/** The canonical text of 4 or 16 address bytes (dotted quad, or RFC 5952 compressed IPv6). */
export function formatAddress(bytes: Uint8Array): string {
  if (bytes.length === 4) return Array.from(bytes).join(".");
  const words: number[] = [];
  for (let i = 0; i < 16; i += 2) words.push((bytes[i]! << 8) | bytes[i + 1]!);
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (words[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = words.map((w) => w.toString(16));
  if (bestStart === -1) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLen).join(":")}`;
}

/** 4 or 16 bytes for a literal IP in its strict form (dotted quad, or IPv6 with or without brackets). */
export function parseIpLiteral(text: string): Uint8Array | undefined {
  return parseIPv4(text) ?? parseIPv6(text);
}

// --- classification --------------------------------------------------------------------------------

function inV4(b: Uint8Array, a0: number, a1: number, a2: number, a3: number, bits: number): boolean {
  const value = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  const base = ((a0 << 24) | (a1 << 16) | (a2 << 8) | a3) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) >>> 0 === (base & mask) >>> 0;
}

/** Classifies 4 IPv4 bytes. */
export function classifyIPv4Bytes(b: Uint8Array): AddressVerdict {
  if (inV4(b, 0, 0, 0, 0, 8)) return refuse("unspecified");
  if (inV4(b, 10, 0, 0, 0, 8)) return refuse("private");
  if (inV4(b, 100, 64, 0, 0, 10)) return refuse("cgnat");
  if (inV4(b, 127, 0, 0, 0, 8)) return refuse("loopback");
  if (inV4(b, 169, 254, 0, 0, 16)) return refuse("link-local");
  if (inV4(b, 172, 16, 0, 0, 12)) return refuse("private");
  if (inV4(b, 192, 0, 0, 0, 24)) return refuse("reserved");
  if (inV4(b, 192, 0, 2, 0, 24)) return refuse("documentation");
  if (inV4(b, 192, 88, 99, 0, 24)) return refuse("reserved");
  if (inV4(b, 192, 168, 0, 0, 16)) return refuse("private");
  if (inV4(b, 198, 18, 0, 0, 15)) return refuse("benchmarking");
  if (inV4(b, 198, 51, 100, 0, 24)) return refuse("documentation");
  if (inV4(b, 203, 0, 113, 0, 24)) return refuse("documentation");
  if (inV4(b, 224, 0, 0, 0, 4)) return refuse("multicast");
  if (inV4(b, 255, 255, 255, 255, 32)) return refuse("broadcast");
  if (inV4(b, 240, 0, 0, 0, 4)) return refuse("reserved");
  return PUBLIC;
}

function prefixIs(b: Uint8Array, prefix: readonly number[], bits: number): boolean {
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3;
    const bit = 7 - (i & 7);
    if (((b[byte]! >> bit) & 1) !== (((prefix[byte] ?? 0) >> bit) & 1)) return false;
  }
  return true;
}

function embedded(b: Uint8Array, at: number, xor = 0): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = b[at + i]! ^ xor;
  return out;
}

function viaEmbedded(v4: Uint8Array): AddressVerdict {
  const inner = classifyIPv4Bytes(v4);
  return inner.public ? PUBLIC : refuse(inner.reason, formatAddress(v4));
}

/** Classifies 16 IPv6 bytes, IPv4 embeddings by the address they embed. */
export function classifyIPv6Bytes(b: Uint8Array): AddressVerdict {
  const zeroUpTo = (n: number): boolean => b.subarray(0, n).every((x) => x === 0);
  if (b.every((x) => x === 0)) return refuse("unspecified");
  if (zeroUpTo(15) && b[15] === 1) return refuse("loopback");
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible).
  if (zeroUpTo(10) && b[10] === 0xff && b[11] === 0xff) return viaEmbedded(embedded(b, 12));
  if (zeroUpTo(12)) return viaEmbedded(embedded(b, 12));
  // ::ffff:0:a.b.c.d (IPv4-translated, RFC 2765).
  if (zeroUpTo(8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return viaEmbedded(embedded(b, 12));
  // 64:ff9b::/96 (NAT64 well-known prefix) and 64:ff9b:1::/48 (local-use NAT64, RFC 8215).
  if (prefixIs(b, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) return viaEmbedded(embedded(b, 12));
  if (prefixIs(b, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48)) return refuse("local-nat64");
  // 100::/64 (discard-only).
  if (prefixIs(b, [0x01, 0x00, 0, 0, 0, 0, 0, 0], 64)) return refuse("reserved");
  if (prefixIs(b, [0xfe, 0x80], 10)) return refuse("link-local");
  if (prefixIs(b, [0xfe, 0xc0], 10)) return refuse("site-local");
  if (prefixIs(b, [0xfc, 0x00], 7)) return refuse("unique-local");
  if (prefixIs(b, [0xff], 8)) return refuse("multicast");
  // Teredo, 2001::/32: server address in bytes 4-7, the client's in bytes 12-15 (bit-inverted).
  if (prefixIs(b, [0x20, 0x01, 0x00, 0x00], 32)) {
    const server = viaEmbedded(embedded(b, 4));
    if (!server.public) return server;
    return viaEmbedded(embedded(b, 12, 0xff));
  }
  if (prefixIs(b, [0x20, 0x01, 0x0d, 0xb8], 32)) return refuse("documentation");
  if (prefixIs(b, [0x3f, 0xff], 20)) return refuse("documentation");
  if (prefixIs(b, [0x20, 0x01, 0x00, 0x10], 28) || prefixIs(b, [0x20, 0x01, 0x00, 0x20], 28)) return refuse("reserved");
  // 6to4, 2002::/16: the IPv4 address is bytes 2-5.
  if (prefixIs(b, [0x20, 0x02], 16)) return viaEmbedded(embedded(b, 2));
  if (!prefixIs(b, [0x20], 3)) return refuse("not-global-unicast");
  return PUBLIC;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The addresses assigned to this machine's own interfaces. Read on every call: interfaces come and go. */
function localInterfaceAddresses(): Uint8Array[] {
  const out: Uint8Array[] = [];
  let table: ReturnType<typeof networkInterfaces>;
  try {
    table = networkInterfaces();
  } catch {
    return out;
  }
  for (const list of Object.values(table)) {
    for (const entry of list ?? []) {
      const bytes = parseIpLiteral(entry.address.split("%")[0]!);
      if (bytes !== undefined) out.push(bytes);
    }
  }
  return out;
}

/** The IPv4 address an IPv4-mapped IPv6 address carries, else `undefined`. */
function unmapped(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.length !== 16) return undefined;
  if (bytes.subarray(0, 10).every((x) => x === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12);
  return undefined;
}

/** Classifies parsed address bytes, this machine's own interface addresses included. */
export function classifyAddressBytes(bytes: Uint8Array): AddressVerdict {
  const verdict = bytes.length === 4 ? classifyIPv4Bytes(bytes) : classifyIPv6Bytes(bytes);
  if (!verdict.public) return verdict;
  const asV4 = unmapped(bytes);
  for (const local of localInterfaceAddresses()) {
    if (sameBytes(local, bytes) || (asV4 !== undefined && sameBytes(local, asV4))) return refuse("local-interface");
  }
  return verdict;
}

/**
 * Classifies one address as a resolver returns it (a strict literal). Something that does not parse
 * as an IP address is refused (`unparseable`): it could not be connected to as given, and a
 * classifier never guesses in the open direction.
 */
export function classifyAddress(address: string): AddressVerdict {
  if (address.includes("%")) return refuse("zone-id");
  const bytes = parseIpLiteral(address);
  if (bytes === undefined) return refuse("unparseable");
  return classifyAddressBytes(bytes);
}

/** `localhost`/`*.localhost` (RFC 6761) and `local`/`*.local` (mDNS): private by name. One trailing dot is ignored. */
export function isReservedPrivateName(hostname: string): boolean {
  let h = hostname.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h === "localhost" || h.endsWith(".localhost") || h === "local" || h.endsWith(".local");
}

/** A hostname (as a URL carries it) that is itself an address literal, in any notation: its bytes. */
export function hostnameAsAddress(hostname: string): Uint8Array | undefined {
  if (hostname.startsWith("[") || hostname.includes(":")) return parseIPv6(hostname);
  return parseIPv4(hostname) ?? parseIPv4Loose(hostname);
}

/**
 * The LEXICAL verdict for a hostname: an address literal (any notation) classified by its bytes, a
 * reserved private name, a zone id -- or `undefined` when only resolution can tell (an ordinary DNS
 * name).
 */
export function classifyHostnameLexically(hostname: string): AddressVerdict | undefined {
  if (hostname.includes("%")) return refuse("zone-id");
  const literal = hostnameAsAddress(hostname);
  if (literal !== undefined) return classifyAddressBytes(literal);
  if (hostname.startsWith("[") || hostname.includes(":")) return refuse("unparseable");
  // A host whose last label is a number but which is no valid IPv4 literal (`08.0.0.1`,
  // `1.2.3.4.5`, `4294967296`): the URL parser refuses these, and so does this classifier.
  const labels = hostname.replace(/\.$/, "").split(".");
  if (/^(?:0x[0-9a-f]*|[0-9]+)$/i.test(labels[labels.length - 1] ?? "")) return refuse("unparseable");
  if (isReservedPrivateName(hostname)) return refuse("reserved-name");
  return undefined;
}
