// Edge cases of `transcriptProjectKey`: the directory name a session's transcripts are filed under.
// The key format is an on-disk interface (existing transcript directories must keep resolving), so
// every expected value below is a literal.
import { describe, expect, test } from "bun:test";
import { transcriptProjectKey, TRANSCRIPT_PROJECT_KEY_MAX_LENGTH, isVendorCompliantProjectKey } from "./project-key.ts";

describe("transcriptProjectKey: the short form (sanitized length <= 64)", () => {
  test("the empty string maps to the empty string", () => {
    expect(transcriptProjectKey("")).toBe("");
  });

  test("a sanitized length of 63 is returned as is", () => {
    expect(transcriptProjectKey("/" + "b".repeat(62))).toBe("-" + "b".repeat(62));
  });

  test("a sanitized length of exactly 64 is returned as is", () => {
    expect(transcriptProjectKey("/" + "b".repeat(63))).toBe("-" + "b".repeat(63));
  });

  test("backslashes and a drive colon each become one dash", () => {
    expect(transcriptProjectKey("C:\\Users\\x")).toBe("C--Users-x");
  });

  test("a lone surrogate code unit is one dash", () => {
    expect(transcriptProjectKey("/a\ud800b")).toBe("-a-b");
  });

  test("non-ASCII letters and digits (fullwidth forms) are dashes; only ASCII letters and digits survive", () => {
    expect(transcriptProjectKey("/ＡＢ１")).toBe("----");
    expect(transcriptProjectKey("/Az09_.~")).toBe("-Az09---");
  });

  test("an astral character counts as two code units toward the 64 limit", () => {
    // 1 + 61 + 2 = 64 code units after sanitizing: still the short form.
    expect(transcriptProjectKey("/" + "a".repeat(61) + "😀")).toBe("-" + "a".repeat(61) + "--");
  });
});

describe("transcriptProjectKey: the long form (sanitized length > 64)", () => {
  test("65 and 66 sanitized code units: exactly 64 characters, prefix + '-' + base-36 suffix", () => {
    expect(transcriptProjectKey("/" + "b".repeat(64))).toBe("-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-e8spg1");
    expect(transcriptProjectKey("/" + "b".repeat(65))).toBe("-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-fe1kvh");
  });

  test("the suffix hashes the ORIGINAL path: two paths with the same sanitized form get different keys", () => {
    const withSpace = transcriptProjectKey("/a b" + "c".repeat(70));
    const withDash = transcriptProjectKey("/a-b" + "c".repeat(70));
    expect(withSpace).toBe("-a-bccccccccccccccccccccccccccccccccccccccccccccccccccccc-3rnvuc");
    expect(withDash).toBe("-a-bccccccccccccccccccccccccccccccccccccccccccccccccccccc-nhaiex");
  });

  test("a hash of zero gives the one-character suffix `0`, and the prefix grows to 62 characters", () => {
    const key = transcriptProjectKey("/Users/alice/projects/zero/zero/zero/zero/zero/zero/zero/zero/zero/zero/1urgtod");
    expect(key).toBe("-Users-alice-projects-zero-zero-zero-zero-zero-zero-zero-zero--0");
    expect(key.length).toBe(64);
  });

  test("the most negative 32-bit hash has magnitude 2^31, whose base-36 form is `zik0zk`", () => {
    const key = transcriptProjectKey("/Users/alice/projects/deep/deep/deep/deep/deep/deep/deep/deep/deep/deep/1jee`lu");
    expect(key).toBe("-Users-alice-projects-deep-deep-deep-deep-deep-deep-deep--zik0zk");
    expect(isVendorCompliantProjectKey(key)).toBe(true);
  });

  test("an all-astral path: every character two dashes, truncated by code units", () => {
    expect(transcriptProjectKey("/" + "😀".repeat(40))).toBe("----------------------------------------------------------km18rr");
  });

  test("a long astral tail is cut in the middle of its dash pair without harm (the key is ASCII)", () => {
    expect(transcriptProjectKey("/" + "a".repeat(62) + "😀")).toBe("-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-jo3rm6");
  });

  test("a long unicode path", () => {
    expect(transcriptProjectKey("/Users/é/" + "ü".repeat(80))).toBe("-Users----------------------------------------------------gjq13w");
  });

  test("every long-form key is exactly the maximum length and vendor-compliant", () => {
    expect(TRANSCRIPT_PROJECT_KEY_MAX_LENGTH).toBe(64);
    for (const p of ["/" + "x".repeat(100), "/" + "é".repeat(500), "/" + "😀".repeat(1000), "/a b/" + "c".repeat(5000)]) {
      const key = transcriptProjectKey(p);
      expect(key.length).toBe(64);
      expect(key).toMatch(/^[A-Za-z0-9-]{57,62}-[0-9a-z]{1,6}$/);
      expect(isVendorCompliantProjectKey(key)).toBe(true);
    }
  });
});
