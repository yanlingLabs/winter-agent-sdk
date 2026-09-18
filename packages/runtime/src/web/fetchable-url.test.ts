// The ONE predicate the executor and the permission evaluator share (whole-branch review M2). What is
// pinned here is the RULE; that each side really uses it is pinned where each side is tested
// (`_web-fetch-net.test.ts`'s `Invalid URL` cases, `permissions/web-tools.test.ts`'s "no ask fires").
import { describe, expect, test } from "bun:test";
import { fetchTimeUrlRefusal, isCertainlyUnfetchableUrl, upgradeToHttps, FETCH_TIME_INVALID_URL, FETCHABLE_TARGET_SHAPE } from "./fetchable-url.ts";

const u = (raw: string): URL => new URL(raw);

describe("upgradeToHttps", () => {
  test("http is upgraded, unconditionally, and nothing else is touched", () => {
    expect(upgradeToHttps(u("http://example.com:8080/a?b=1#c")).toString()).toBe("https://example.com:8080/a?b=1#c");
    // Even for a loopback address -- which is the whole reason a plain-http dev server is unreachable.
    expect(upgradeToHttps(u("http://127.0.0.1:5173/")).toString()).toBe("https://127.0.0.1:5173/");
    for (const raw of ["https://example.com/", "ftp://example.com/", "file:///etc/hosts"]) {
      expect(upgradeToHttps(u(raw)).toString()).toBe(u(raw).toString());
    }
  });
});

describe("claude's three fetch-time rejects", () => {
  test("a hostname with fewer than two dot-separated labels", () => {
    for (const raw of ["https://localhost:5173/", "https://intranet/docs", "https://[::1]:3000/", "https://[fd00::1]/", "file:///etc/hosts"]) {
      expect([raw, fetchTimeUrlRefusal(u(raw))]).toEqual([raw, "single-label-hostname"]);
    }
  });

  test("two or more labels pass -- including the shapes that LOOK local", () => {
    for (const raw of ["https://127.0.0.1:3000/", "https://192.168.1.10/", "https://api.localhost/", "https://printer.local/", "https://localhost./", "https://example.com/"]) {
      expect([raw, fetchTimeUrlRefusal(u(raw))]).toEqual([raw, undefined]);
    }
  });

  test("embedded credentials, and a url over 2000 characters", () => {
    expect(fetchTimeUrlRefusal(u("https://user:secret@example.com/x"))).toBe("embedded-credentials");
    expect(fetchTimeUrlRefusal(u("https://user@example.com/x"))).toBe("embedded-credentials");
    expect(fetchTimeUrlRefusal(u(`https://example.com/${"a".repeat(2000)}`))).toBe("too-long");
    expect(fetchTimeUrlRefusal(u(`https://example.com/${"a".repeat(1900)}`))).toBeUndefined();
  });
});

describe("isCertainlyUnfetchableUrl -- the question the permission layer asks", () => {
  test("it applies the upgrade FIRST, so an http url is judged as the https one that will be tried", () => {
    expect(isCertainlyUnfetchableUrl(u("http://localhost:5173/"))).toBe("single-label-hostname");
    expect(isCertainlyUnfetchableUrl(u("http://[::1]:5173/"))).toBe("single-label-hostname");
    expect(isCertainlyUnfetchableUrl(u("http://user:pw@example.com/"))).toBe("embedded-credentials");
    // A plain-http private target IS attempted (and then fails to connect): it is not this predicate's
    // business, and it is exactly the case an approval can still be about.
    expect(isCertainlyUnfetchableUrl(u("http://127.0.0.1:5173/"))).toBeUndefined();
    expect(isCertainlyUnfetchableUrl(u("http://printer.local/"))).toBeUndefined();
  });
});

describe("the shared texts", () => {
  test("the refusal text is claude's bare one, and the shape sentence names what actually works", () => {
    expect(FETCH_TIME_INVALID_URL).toBe("Invalid URL");
    expect(FETCHABLE_TARGET_SHAPE).toContain("upgrades http to https");
    expect(FETCHABLE_TARGET_SHAPE).toContain("two or more dot-separated labels");
    expect(FETCHABLE_TARGET_SHAPE).not.toContain("dev server");
  });
});
