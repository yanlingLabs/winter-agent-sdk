import { describe, expect, test } from "bun:test";
import { classifyHostname, classifyHostnameLexically, classifyIpv4, classifyIpv6, classifyResolvedAddress, stripIpv6Brackets } from "./private-address.ts";

describe("classifyIpv4", () => {
  test("private/loopback/link-local/CGNAT ranges", () => {
    expect(classifyIpv4("127.0.0.1")?.class).toBe("private");
    expect(classifyIpv4("10.1.2.3")?.class).toBe("private");
    expect(classifyIpv4("172.16.0.1")?.class).toBe("private");
    expect(classifyIpv4("172.31.255.255")?.class).toBe("private");
    expect(classifyIpv4("172.32.0.1")?.class).toBe("public"); // just outside 172.16.0.0/12
    expect(classifyIpv4("192.168.1.1")?.class).toBe("private");
    expect(classifyIpv4("169.254.1.1")?.class).toBe("private");
    expect(classifyIpv4("100.64.0.1")?.class).toBe("private");
    expect(classifyIpv4("100.127.255.255")?.class).toBe("private");
    expect(classifyIpv4("100.128.0.1")?.class).toBe("public");
    expect(classifyIpv4("0.0.0.0")?.class).toBe("private");
  });

  test("public addresses", () => {
    expect(classifyIpv4("8.8.8.8")?.class).toBe("public");
    expect(classifyIpv4("1.1.1.1")?.class).toBe("public");
  });

  test("not an IPv4 literal at all -> undefined", () => {
    expect(classifyIpv4("example.com")).toBeUndefined();
    expect(classifyIpv4("999.1.1.1")).toBeUndefined();
  });
});

describe("classifyIpv6", () => {
  test("loopback and unspecified", () => {
    expect(classifyIpv6("::1")?.class).toBe("private");
    expect(classifyIpv6("::")?.class).toBe("private");
  });

  test("unique local and link-local", () => {
    expect(classifyIpv6("fc00::1")?.class).toBe("private");
    expect(classifyIpv6("fd12:3456:789a::1")?.class).toBe("private");
    expect(classifyIpv6("fe80::1")?.class).toBe("private");
  });

  test("IPv4-mapped IPv6 classifies the embedded IPv4", () => {
    expect(classifyIpv6("::ffff:127.0.0.1")?.class).toBe("private");
    expect(classifyIpv6("::ffff:7f00:1")?.class).toBe("private"); // same address, hex-group form
    expect(classifyIpv6("::ffff:8.8.8.8")?.class).toBe("public");
  });

  test("public IPv6", () => {
    expect(classifyIpv6("2606:4700:4700::1111")?.class).toBe("public"); // Cloudflare DNS
  });

  test("not an IPv6 literal at all -> undefined", () => {
    expect(classifyIpv6("example.com")).toBeUndefined();
  });
});

describe("classifyHostnameLexically", () => {
  test("IP literals both families", () => {
    expect(classifyHostnameLexically("127.0.0.1")?.class).toBe("private");
    expect(classifyHostnameLexically("[::1]")?.class).toBe("private");
    expect(stripIpv6Brackets("[::1]")).toBe("::1");
  });

  test("reserved names: localhost and .local, whole and subdomain", () => {
    expect(classifyHostnameLexically("localhost")?.class).toBe("private");
    expect(classifyHostnameLexically("sub.localhost")?.class).toBe("private");
    expect(classifyHostnameLexically("mydevice.local")?.class).toBe("private");
    expect(classifyHostnameLexically("LOCALHOST")?.class).toBe("private"); // case-insensitive
  });

  test("an ordinary DNS name is not lexically decidable", () => {
    expect(classifyHostnameLexically("example.com")).toBeUndefined();
  });
});

describe("classifyResolvedAddress", () => {
  test("a resolved private address is private even for an innocuous-looking hostname's answer", () => {
    expect(classifyResolvedAddress("127.0.0.1").class).toBe("private");
    expect(classifyResolvedAddress("93.184.216.34").class).toBe("public");
  });
});

describe("classifyHostname (lexical, then resolved)", () => {
  test("lexical decision short-circuits -- resolver is never called", async () => {
    let called = false;
    const resolve = async () => {
      called = true;
      return ["8.8.8.8"];
    };
    const verdict = await classifyHostname("127.0.0.1", resolve);
    expect(verdict.class).toBe("private");
    expect(called).toBe(false);
  });

  test("a public-looking name that RESOLVES to loopback is private (rebinding case)", async () => {
    const verdict = await classifyHostname("public-looking.example", async () => ["127.0.0.1"]);
    expect(verdict.class).toBe("private");
  });

  test("a name resolving only to public addresses is public", async () => {
    const verdict = await classifyHostname("example.com", async () => ["93.184.216.34"]);
    expect(verdict.class).toBe("public");
  });

  test("ANY private address among several makes the whole hostname private", async () => {
    const verdict = await classifyHostname("example.com", async () => ["93.184.216.34", "127.0.0.1"]);
    expect(verdict.class).toBe("private");
  });

  test("an unresolvable name is treated as public (the fetch step reports the real failure)", async () => {
    const verdict = await classifyHostname("nonexistent.invalid", async () => {
      throw new Error("ENOTFOUND");
    });
    expect(verdict.class).toBe("public");
  });
});
