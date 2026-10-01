import { describe, expect, test } from "bun:test";
import { collectSiteIcons, pageIconUrl, SITE_ICONS_MAX, siteIconHttpsUrl } from "./_site-icons.ts";

describe("pageIconUrl -- the icon a fetched page declares", () => {
  const page = "https://docs.example.com/guide/intro";

  test("apple-touch-icon over icon over shortcut icon, resolved against the page", () => {
    expect(pageIconUrl('<link rel="shortcut icon" href="/f.ico"><link rel="icon" href="img/i.png">', page)).toBe("https://docs.example.com/f.ico");
    expect(pageIconUrl('<link rel="icon" href="img/i.png"><link rel="apple-touch-icon" href="/touch.png">', page)).toBe("https://docs.example.com/touch.png");
    expect(pageIconUrl("<LINK REL='ICON' HREF='img/i.png'>", page)).toBe("https://docs.example.com/guide/img/i.png");
    expect(pageIconUrl("<link rel=icon href=//cdn.example.net/i.png>", page)).toBe("https://cdn.example.net/i.png");
  });

  test("entities in the href are decoded", () => {
    expect(pageIconUrl('<link rel="icon" href="/i.png?v=2&amp;x=1">', page)).toBe("https://docs.example.com/i.png?v=2&x=1");
  });

  test("never a mask-icon, an SVG, a data: url or a plain-http icon -- the origin's /favicon.ico instead", () => {
    expect(pageIconUrl('<link rel="mask-icon" href="/m.png"><link rel="icon" href="/logo.svg"><link rel="icon" href="data:image/png;base64,AAAA"><link rel="icon" href="http://docs.example.com/i.png">', page)).toBe("https://docs.example.com/favicon.ico");
    expect(pageIconUrl("<p>no head at all</p>", page)).toBe("https://docs.example.com/favicon.ico");
  });

  test("nothing for a page that is not https to a public name", () => {
    expect(pageIconUrl('<link rel="icon" href="/i.png">', "http://docs.example.com/")).toBeUndefined();
    expect(pageIconUrl('<link rel="icon" href="/i.png">', "https://127.0.0.1/")).toBeUndefined();
    expect(pageIconUrl('<link rel="icon" href="/i.png">', "https://printer.local/")).toBeUndefined();
    expect(pageIconUrl('<link rel="icon" href="/i.png">', "https://intranet/")).toBeUndefined();
  });

  test("names that conventionally stay on the user's own network are refused; only the suffix counts", () => {
    for (const host of ["nas.lan", "router.home", "box.home.arpa", "wiki.corp", "hr.intranet", "x.private", "a.localhost", "db.internal", "printer.local"]) {
      expect(siteIconHttpsUrl(`https://${host}/favicon.ico`)).toBeUndefined();
      expect(pageIconUrl("", `https://${host}/page`)).toBeUndefined();
    }
    for (const host of ["lan.example.com", "myhome.com", "corp.example.org", "private.example.net"]) {
      expect(siteIconHttpsUrl(`https://${host}/favicon.ico`)).toBe(`https://${host}/favicon.ico`);
    }
  });
});

describe("siteIconHttpsUrl / collectSiteIcons -- the bounds the host relies on", () => {
  test("https to a public name only; no credentials; length-capped; re-serialised to ASCII", () => {
    expect(siteIconHttpsUrl("https://a.example.com/i.png")).toBe("https://a.example.com/i.png");
    expect(siteIconHttpsUrl("http://a.example.com/i.png")).toBeUndefined();
    expect(siteIconHttpsUrl("https://u:p@a.example.com/i.png")).toBeUndefined();
    expect(siteIconHttpsUrl("https://[::1]/i.png")).toBeUndefined();
    expect(siteIconHttpsUrl(`https://a.example.com/${"x".repeat(3000)}`)).toBeUndefined();
    expect(siteIconHttpsUrl("https://a.example.com/ï.png")).toBe("https://a.example.com/%C3%AF.png");
    expect(siteIconHttpsUrl(7)).toBeUndefined();
  });

  test("one entry per page url, at most SITE_ICONS_MAX, a bad pair dropped", () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ url: `https://s${i % 14}.example.com/`, iconUrl: `https://s${i}.example.com/i.png` }));
    entries.unshift({ url: "https://bad.example.com/", iconUrl: "javascript:alert(1)" });
    const out = collectSiteIcons(entries)!;
    expect(out).toHaveLength(SITE_ICONS_MAX);
    expect(new Set(out.map((e) => e.url)).size).toBe(SITE_ICONS_MAX);
    expect(out.some((e) => e.url.startsWith("https://bad."))).toBe(false);
    expect(collectSiteIcons([])).toBeUndefined();
  });
});
