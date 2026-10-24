import { BUN_TEST, harness, isBun, type BunTestModule } from "./harness.test-support.ts";
import assert from "node:assert/strict";
import { networkInterfaces } from "node:os";
import { classifyAddress, classifyHostnameLexically, formatAddress, parseIPv4Loose, parseIPv6 } from "./address.ts";

const { describe, test } = await harness(isBun ? ((await import(BUN_TEST)) as BunTestModule) : undefined);

const refused = (address: string): boolean => !classifyAddress(address).public;
const lexicallyRefused = (host: string): boolean => {
  const v = classifyHostnameLexically(host);
  return v !== undefined && !v.public;
};

describe("IPv4", () => {
  test("every non-public block is refused", () => {
    for (const a of [
      "0.0.0.0",
      "0.1.2.3",
      "10.0.0.1",
      "10.255.255.255",
      "100.64.0.1",
      "100.100.100.200", // a cloud metadata address inside CGNAT
      "100.127.255.255",
      "127.0.0.1",
      "127.255.255.254",
      "169.254.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.192",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.0.1",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.7",
      "203.0.113.9",
      "224.0.0.1",
      "239.255.255.250",
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      assert.ok(refused(a), a);
    }
  });

  test("neighbours of the blocks are public", () => {
    for (const a of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "126.255.255.255", "128.0.0.0", "169.253.255.255", "169.255.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0", "198.17.255.255", "198.20.0.0", "223.255.255.255"]) {
      assert.ok(!refused(a), a);
    }
  });

  test("every inet_aton notation parses to the same address", () => {
    for (const text of ["127.0.0.1", "2130706433", "0177.0.0.1", "0x7f.0.0.1", "0x7F.0.0.1", "0x7f.1", "127.1", "127.0.1", "0x7f000001", "017700000001", "127.0.0.1.", "0177.0x0.0.01"]) {
      assert.equal(parseIPv4Loose(text)?.join("."), "127.0.0.1", text);
      assert.ok(lexicallyRefused(text), text);
    }
    assert.equal(parseIPv4Loose("0xa9fea9fe")?.join("."), "169.254.169.254");
    assert.equal(parseIPv4Loose("0")?.join("."), "0.0.0.0");
  });

  test("a numeric-looking host that is not a valid literal is refused, not resolved", () => {
    for (const text of ["08.0.0.1", "1.2.3.4.5", "4294967296", "256.1.1.1", "0x100000000"]) {
      assert.ok(lexicallyRefused(text), text);
    }
  });

  test("ordinary names are left to resolution", () => {
    for (const host of ["example.com", "a.b.c.example", "1.2.3.example", "0x7f.example"]) assert.equal(classifyHostnameLexically(host), undefined, host);
  });
});

describe("IPv6", () => {
  test("parsing: compression, embedded dotted quads, brackets; zone ids and junk refused", () => {
    assert.equal(formatAddress(parseIPv6("0:0:0:0:0:ffff:7f00:1")!), "::ffff:7f00:1");
    assert.equal(formatAddress(parseIPv6("::ffff:127.0.0.1")!), "::ffff:7f00:1");
    assert.equal(formatAddress(parseIPv6("[::1]")!), "::1");
    assert.equal(formatAddress(parseIPv6("1:2:3:4:5:6:1.2.3.4")!), "1:2:3:4:5:6:102:304");
    assert.equal(formatAddress(parseIPv6("1:2:3:4:5:6:7::")!), "1:2:3:4:5:6:7:0");
    for (const bad of [":::1", "1:2", "1::2::3", "fe80::1%en0", "12345::", "1:2:3:4:5:6:7:8:9", "::1.2.3", "::ffff:256.0.0.1", "g::1"]) assert.equal(parseIPv6(bad), undefined, bad);
  });

  test("loopback, unspecified, ULA (metadata fd00:ec2::254 included), link-local, site-local, multicast, discard, documentation", () => {
    for (const a of ["::1", "::", "fd00:ec2::254", "fc00::1", "fdff:ffff::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "ff05::2", "100::1", "2001:db8::1", "3fff::1", "2001:10::1", "2001:20::1", "64:ff9b:1::1"]) {
      assert.ok(refused(a), a);
    }
  });

  test("IPv4 embeddings are judged by the address they carry", () => {
    for (const a of [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "0:0:0:0:0:ffff:127.0.0.1",
      "::ffff:a9fe:a9fe",
      "::ffff:10.0.0.1",
      "::127.0.0.1", // IPv4-compatible
      "::ffff:0:10.0.0.1", // IPv4-translated
      "64:ff9b::7f00:1", // NAT64
      "64:ff9b::a9fe:a9fe",
      "2002:7f00:1::", // 6to4
      "2002:a9fe:a9fe::1",
      "2001:0:7f00:1::1", // Teredo, private server
      "2001:0:808:808:0:0:80ff:fffe", // Teredo, client 127.0.0.1 (bit-inverted)
    ]) {
      assert.ok(refused(a), a);
    }
    for (const a of ["::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1", "2001:0:808:808:0:0:f7f7:f7f7"]) assert.ok(!refused(a), a);
  });

  test("outside 2000::/3 is refused; ordinary global unicast is public", () => {
    for (const a of ["4000::1", "1::", "8000::1", "e000::1"]) assert.ok(refused(a), a);
    for (const a of ["2606:4700:4700::1111", "2a00:1450:4001::200e", "2001:4860:4860::8888"]) assert.ok(!refused(a), a);
  });

  test("a resolver answer that is no address, or carries a zone id, is refused", () => {
    assert.ok(refused("not-an-address"));
    assert.ok(refused("fe80::1%lo0"));
    assert.ok(refused(""));
    assert.deepEqual(classifyAddress("fe80::1%lo0"), { public: false, reason: "zone-id" });
  });

  test("each refusal names its reason (the specific rule, not only the 2000::/3 catch-all)", () => {
    assert.deepEqual(classifyAddress("::1"), { public: false, reason: "loopback" });
    assert.deepEqual(classifyAddress("fd00:ec2::254"), { public: false, reason: "unique-local" });
    assert.deepEqual(classifyAddress("fe80::1"), { public: false, reason: "link-local" });
    assert.deepEqual(classifyAddress("ff02::1"), { public: false, reason: "multicast" });
    assert.deepEqual(classifyAddress("::127.0.0.1"), { public: false, reason: "loopback", embedded: "127.0.0.1" });
    assert.deepEqual(classifyAddress("::ffff:a9fe:a9fe"), { public: false, reason: "link-local", embedded: "169.254.169.254" });
    for (const host of ["0x7f.1", "2130706433", "0177.0.0.1", "127.1"]) assert.deepEqual(classifyHostnameLexically(host), { public: false, reason: "loopback" }, host);
  });
});

describe("names and local interfaces", () => {
  test("localhost and .local are private by name, a trailing dot and case notwithstanding", () => {
    for (const h of ["localhost", "LOCALHOST", "localhost.", "api.localhost", "printer.local", "Printer.Local.", "local"]) assert.ok(lexicallyRefused(h), h);
    for (const h of ["localhost.example", "local.example", "notlocalhost"]) assert.ok(!lexicallyRefused(h), h);
  });

  test("an address on one of this machine's own interfaces is refused", () => {
    for (const list of Object.values(networkInterfaces())) {
      for (const entry of list ?? []) assert.ok(refused(entry.address.split("%")[0]!), entry.address);
    }
  });
});
