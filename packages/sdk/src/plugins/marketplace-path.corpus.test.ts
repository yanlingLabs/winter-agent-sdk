// A recorded input -> output corpus for `resolveMarketplacePluginPath`: 2000 generated
// (installLocation, pluginRoot, source) triples -- traversal, absolute paths, `.`/`..` runs, `//`,
// backslashes, drive letters, unicode, NUL, empty and non-string values -- with the answer the resolver
// gave when the corpus was recorded (`null` = refused). `{"$undefined": true}` encodes `undefined`.
import { expect, test } from "bun:test";
import { resolveMarketplacePluginPath } from "./marketplace-path.ts";
import corpus from "./__corpus__/marketplace-path.json";

const decode = (v: unknown): unknown => (v !== null && typeof v === "object" && (v as { $undefined?: boolean }).$undefined === true ? undefined : v);

test("the recorded corpus resolves exactly as recorded", () => {
  const rows = corpus as Array<{ installLocation: string; pluginRoot: unknown; source: unknown; expected: string | null }>;
  expect(rows.length).toBe(2000);
  const mismatches = rows.filter((row) => (resolveMarketplacePluginPath(row.installLocation, decode(row.pluginRoot), decode(row.source)) ?? null) !== row.expected);
  expect(mismatches).toEqual([]);
});
