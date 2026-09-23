// Fix round 3 (I-1, security): the shared marketplace-manifest plugin-path resolver. Ported from the
// pinned binary's own `Gyn`/`Vyn`/`E3t`/`Zs`/`Aoe` (claude CLI 2.1.250 / agent-sdk 0.3.250,
// dump-confirmed -- see marketplace-path.ts's own header for the exact offsets). Every test here is
// a case the pre-fix-round-3 `resolve(installLocation, pluginRoot, entry.source)` got wrong.
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

  test("a plugin whose real resolved location sits exactly ON the base's own name as a substring (not inside it) is still refused", () => {
    // A naive `resolved.startsWith(base)` check would wrongly accept this -- Aoe's own "+sep" rule
    // is what this proves.
    expect(resolveMarketplacePluginPath("/marketplace", undefined, "../marketplace-evil/x")).toBeUndefined();
  });
});

describe("resolveMarketplacePluginPath -- the './x with pluginRoot set' double-join bug (I-1)", () => {
  test("an explicit './relative/path' source IGNORES pluginRoot entirely -- no doubling", () => {
    const result = resolveMarketplacePluginPath(BASE, "./plugins", "./plugins/foo");
    expect(result).toBe(join(BASE, "plugins", "foo"));
    // NOT join(BASE, "plugins", "plugins", "foo") -- the pre-fix-round-3 doubled shape.
  });

  test("a bare '.' source resolves to the base itself", () => {
    expect(resolveMarketplacePluginPath(BASE, undefined, ".")).toBe(join(BASE));
  });
});

describe("resolveMarketplacePluginPath -- bare names: only resolve with a usable pluginRoot (claude refuses the rest)", () => {
  test("a bare source name with NO pluginRoot is REFUSED -- claude's own rule, Winter's pre-fix-round-3 gap", () => {
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

  test("a bare source name with pluginRoot '.' resolves directly under the base", () => {
    expect(resolveMarketplacePluginPath(BASE, ".", "foo")).toBe(join(BASE, "foo"));
    expect(resolveMarketplacePluginPath(BASE, "", "foo")).toBeUndefined(); // "" is not a valid string per Gyn's own check -- normalizes only via "." / "./"
  });

  test("a bare source name containing '..' is never treated as bare -- refused even with a valid pluginRoot", () => {
    expect(resolveMarketplacePluginPath(BASE, "plugins", "..")).toBeUndefined();
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

  test("never throws on any input shape -- always undefined or a real path", () => {
    for (const badRoot of [null, 42, {}, [], true]) {
      for (const badSource of [null, 42, {}, [], true, "../x", "/x", "x"]) {
        expect(() => resolveMarketplacePluginPath(BASE, badRoot, badSource)).not.toThrow();
      }
    }
  });
});
