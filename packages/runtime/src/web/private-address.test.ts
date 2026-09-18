import { describe, expect, test } from "bun:test";
import { classifyHostname, classifyHostnameLexically, classifyIpLiteral, classifyResolvedAddress, stripIpv6Brackets } from "./private-address.ts";

describe("classifyIpLiteral -- IPv4", () => {
  test("private/loopback/link-local/CGNAT ranges", () => {
    expect(classifyIpLiteral("127.0.0.1")?.class).toBe("private");
    expect(classifyIpLiteral("10.1.2.3")?.class).toBe("private");
    expect(classifyIpLiteral("172.16.0.1")?.class).toBe("private");
    expect(classifyIpLiteral("172.31.255.255")?.class).toBe("private");
    expect(classifyIpLiteral("172.32.0.1")?.class).toBe("public"); // just outside 172.16.0.0/12
    expect(classifyIpLiteral("192.168.1.1")?.class).toBe("private");
    expect(classifyIpLiteral("169.254.1.1")?.class).toBe("private");
    expect(classifyIpLiteral("100.64.0.1")?.class).toBe("private");
    expect(classifyIpLiteral("100.127.255.255")?.class).toBe("private");
    expect(classifyIpLiteral("100.128.0.1")?.class).toBe("public");
    expect(classifyIpLiteral("0.0.0.0")?.class).toBe("private");
  });

  test("public addresses", () => {
    expect(classifyIpLiteral("8.8.8.8")?.class).toBe("public");
    expect(classifyIpLiteral("1.1.1.1")?.class).toBe("public");
  });

  test("not an IP literal at all -> undefined", () => {
    expect(classifyIpLiteral("example.com")).toBeUndefined();
  });
});

describe("classifyIpLiteral -- IPv6", () => {
  test("loopback and unspecified", () => {
    expect(classifyIpLiteral("::1")?.class).toBe("private");
    expect(classifyIpLiteral("::")?.class).toBe("private");
  });

  test("unique local and link-local", () => {
    expect(classifyIpLiteral("fc00::1")?.class).toBe("private");
    expect(classifyIpLiteral("fd12:3456:789a::1")?.class).toBe("private");
    expect(classifyIpLiteral("fe80::1")?.class).toBe("private");
  });

  test("IPv4-mapped IPv6 classifies the embedded IPv4 -- both dotted-quad and hex-group forms", () => {
    expect(classifyIpLiteral("::ffff:127.0.0.1")?.class).toBe("private");
    expect(classifyIpLiteral("::ffff:7f00:1")?.class).toBe("private"); // same address, hex-group form
    expect(classifyIpLiteral("::ffff:8.8.8.8")?.class).toBe("public");
  });

  test("public IPv6", () => {
    expect(classifyIpLiteral("2606:4700:4700::1111")?.class).toBe("public"); // Cloudflare DNS
  });
});

describe("classifyHostnameLexically", () => {
  test("IP literals both families, brackets stripped for IPv6", () => {
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

  test("an unresolvable name FAILS CLOSED -- private, never public (security review finding M6)", async () => {
    const verdict = await classifyHostname("nonexistent.invalid", async () => {
      throw new Error("ENOTFOUND");
    });
    expect(verdict.class).toBe("private");
  });

  test("a resolver that answers no addresses at all also fails closed", async () => {
    const verdict = await classifyHostname("empty-answer.example", async () => []);
    expect(verdict.class).toBe("private");
  });
});

describe("classifyReservedName -- trailing-dot names", () => {
  test("a single trailing dot (the DNS root) does not defeat the reserved-name check", async () => {
    expect(classifyHostnameLexically("localhost.")?.class).toBe("private");
    expect(classifyHostnameLexically("a.localhost.")?.class).toBe("private");
    expect(classifyHostnameLexically("foo.local.")?.class).toBe("private");
  });
});
