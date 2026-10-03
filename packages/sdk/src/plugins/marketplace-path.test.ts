// The shared marketplace-manifest plugin-path resolver (WS-21, fix round 3, I-1, security). Every
// test here is a case the pre-fix-round-3 `resolve(installLocation, pluginRoot, entry.source)` got
// wrong, or an edge case of the resolver's own contract; `marketplace-path.corpus.test.ts` holds the
// recorded input -> output corpus.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveMarketplacePluginPath } from "./marketplace-path.ts";

const BASE = "/marketplace/root";

describe("resolveMarketplacePluginPath -- security: a source/pluginRoot pair can never escape installLocation", () => {
  test("a relative source with '..' segments is refused, never resolved outside the base", () => {
    expect(resolveMarketplacePluginPath(BASE, undefined, "../../etc/passwd")).toBeUndefined();
    expect(resolveMarketplacePluginPath(BASE, undefined, "./../../etc/passwd")).toBeUndefined();
  });

  test("an ABSOLUTE source is refused", () => {
    expect(resolveMarketplacePluginPath(BASE, undefined, "/etc/passwd")).toBeUndefined();
  });

  test("an ABSOLUTE pluginRoot is refused, even with an otherwise-valid bare source", () => {
    expect(resolveMarketplacePluginPath(BASE, "/etc", "foo")).toBeUndefined();
  });

  test("a pluginRoot containing '..' is refused", () => {
    expect(resolveMarketplacePluginPath(BASE, "../escape", "foo")).toBeUndefined();
    expect(resolveMarketplacePluginPath(BASE, "sub/../../escape", "foo")).toBeUndefined();
  });

  test("a pluginRoot with a Windows-style separator or drive letter is refused", () => {
    expect(resolveMarketplacePluginPath(BASE, "sub\\dir", "foo")).toBeUndefined();
    expect(resolveMarketplacePluginPath(BASE, "C:", "foo")).toBeUndefined();
  });

  test("a plugin whose resolved location shares only a STRING prefix with the base (a sibling directory) is refused", () => {
    // A naive `resolved.startsWith(base)` check would wrongly accept this; the containment check
    // requires the base followed by a path separator (or the base itself).
    expect(resolveMarketplacePluginPath("/marketplace", undefined, "./../marketplace-evil/x")).toBeUndefined();
  });

  test("a '..' that stays INSIDE the base after resolution is allowed; one that leaves it is not", () => {
    expect(resolveMarketplacePluginPath(BASE, undefined, "./a/../b")).toBe(join(BASE, "b"));
    expect(resolveMarketplacePluginPath(BASE, undefined, "./a/..")).toBe(join(BASE));
    expect(resolveMarketplacePluginPath(BASE, undefined, "./a/../../x")).toBeUndefined();
  });
});

describe("resolveMarketplacePluginPath -- the './x with pluginRoot set' double-join bug (I-1)", () => {
  test("an explicit './relative/path' source IGNORES pluginRoot entirely -- no doubling", () => {
    const result = resolveMarketplacePluginPath(BASE, "./plugins", "./plugins/foo");
    expect(result).toBe(join(BASE, "plugins", "foo"));
    // NOT join(BASE, "plugins", "plugins", "foo") -- the pre-fix-round-3 doubled shape.
  });

  test("a bare '.' source resolves to the base itself, with or without a pluginRoot", () => {
    expect(resolveMarketplacePluginPath(BASE, undefined, ".")).toBe(join(BASE));
    expect(resolveMarketplacePluginPath(BASE, "plugins", ".")).toBe(join(BASE));
  });

  test("'./' resolves to the base itself", () => {
    expect(resolveMarketplacePluginPath(BASE, undefined, "./")).toBe(join(BASE));
  });
});

describe("resolveMarketplacePluginPath -- bare names: only resolve with a usable pluginRoot", () => {
  test("a bare source name with NO pluginRoot is REFUSED", () => {
    expect(resolveMarketplacePluginPath(BASE, undefined, "foo")).toBeUndefined();
  });

  test("a bare source name with an INVALID pluginRoot is refused too, not silently unresolved-but-loaded", () => {
    expect(resolveMarketplacePluginPath(BASE, "/etc", "foo")).toBeUndefined();
    expect(resolveMarketplacePluginPath(BASE, "../escape", "foo")).toBeUndefined();
  });

  test("a bare source name WITH a valid pluginRoot resolves under it", () => {
    expect(resolveMarketplacePluginPath(BASE, "plugins", "foo")).toBe(join(BASE, "plugins", "foo"));
    expect(resolveMarketplacePluginPath(BASE, "./plugins/", "foo")).toBe(join(BASE, "plugins", "foo"));
  });

  test("a bare source name with pluginRoot '.' (or './') resolves directly under the base; an EMPTY pluginRoot is invalid", () => {
    expect(resolveMarketplacePluginPath(BASE, ".", "foo")).toBe(join(BASE, "foo"));
    expect(resolveMarketplacePluginPath(BASE, "./", "foo")).toBe(join(BASE, "foo"));
    expect(resolveMarketplacePluginPath(BASE, "", "foo")).toBeUndefined();
  });

  test("a bare source name containing '..' is never treated as bare -- refused even with a valid pluginRoot", () => {
    expect(resolveMarketplacePluginPath(BASE, "plugins", "..")).toBeUndefined();
    expect(resolveMarketplacePluginPath(BASE, "plugins", "foo..bar")).toBeUndefined();
  });

  test("a bare name starts with a letter or digit; the rest may be letters, digits, '-', '.', '_'", () => {
    expect(resolveMarketplacePluginPath(BASE, "plugins", "9lives")).toBe(join(BASE, "plugins", "9lives"));
    expect(resolveMarketplacePluginPath(BASE, "plugins", "a-b_c.d")).toBe(join(BASE, "plugins", "a-b_c.d"));
    // Not bare (bad first character, or a character outside the set): never prefixed, and not a
    // './'-relative path either, so refused.
    expect(resolveMarketplacePluginPath(BASE, "plugins", "-foo")).toBeUndefined();
    expect(resolveMarketplacePluginPath(BASE, "plugins", "_foo")).toBeUndefined();
    expect(resolveMarketplacePluginPath(BASE, "plugins", ".foo")).toBeUndefined();
    expect(resolveMarketplacePluginPath(BASE, "plugins", "foo bar")).toBeUndefined();
    expect(resolveMarketplacePluginPath(BASE, "plugins", "foo/bar")).toBeUndefined();
    expect(resolveMarketplacePluginPath(BASE, "plugins", "föo")).toBeUndefined();
  });

  test("pluginRoot normalisation: one leading './' and any trailing '/'s are dropped; an empty, '.' or '..' segment left after that is invalid", () => {
    expect(resolveMarketplacePluginPath(BASE, "plugins///", "foo")).toBe(join(BASE, "plugins", "foo"));
    expect(resolveMarketplacePluginPath(BASE, "a/b", "foo")).toBe(join(BASE, "a", "b", "foo"));
    expect(resolveMarketplacePluginPath(BASE, "./a/b/", "foo")).toBe(join(BASE, "a", "b", "foo"));
    expect(resolveMarketplacePluginPath(BASE, "a//b", "foo")).toBeUndefined();
    expect(resolveMarketplacePluginPath(BASE, "a/./b", "foo")).toBeUndefined();
    expect(resolveMarketplacePluginPath(BASE, "././a", "foo")).toBeUndefined();
    expect(resolveMarketplacePluginPath(BASE, ".//a", "foo")).toBeUndefined();
    expect(resolveMarketplacePluginPath(BASE, "..", "foo")).toBeUndefined();
  });

  test("a non-string pluginRoot reads as absent", () => {
    for (const root of [null, 42, {}, [], true]) expect(resolveMarketplacePluginPath(BASE, root, "foo")).toBeUndefined();
    for (const root of [null, 42, {}, [], true]) expect(resolveMarketplacePluginPath(BASE, root, "./foo")).toBe(join(BASE, "foo"));
  });
});

describe("resolveMarketplacePluginPath -- ordinary, well-formed inputs (the pre-existing legitimate shapes)", () => {
  test("a nested relative source resolves under the base with no pluginRoot set", () => {
    expect(resolveMarketplacePluginPath(BASE, undefined, "./plugins/p")).toBe(join(BASE, "plugins", "p"));
  });

  test("source undefined/non-string/empty is refused, never a throw", () => {
    expect(resolveMarketplacePluginPath(BASE, undefined, undefined)).toBeUndefined();
    expect(resolveMarketplacePluginPath(BASE, undefined, 42)).toBeUndefined();
    expect(resolveMarketplacePluginPath(BASE, undefined, "")).toBeUndefined();
  });

  test("a trailing slash on the base, or '.' segments in it, do not change the answer", () => {
    expect(resolveMarketplacePluginPath(`${BASE}/`, undefined, "./p")).toBe(join(BASE, "p"));
    expect(resolveMarketplacePluginPath("/marketplace/./root", "plugins", "p")).toBe(join(BASE, "plugins", "p"));
  });

  test("never throws on any input shape -- always undefined or a real path", () => {
    for (const badRoot of [null, 42, {}, [], true]) {
      for (const badSource of [null, 42, {}, [], true, "../x", "/x", "x"]) {
        expect(() => resolveMarketplacePluginPath(BASE, badRoot, badSource)).not.toThrow();
      }
    }
  });
});
