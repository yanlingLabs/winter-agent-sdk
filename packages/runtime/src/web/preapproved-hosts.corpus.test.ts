// A recorded input -> output corpus for the preapproved-host matchers: 2971 generated rows of three
// kinds -- `host` (`isPreapprovedHost(hostname, pathname)` on raw strings), `scope`
// (`preapprovedScopeOf(new URL(url))`, `null` = no scope) and `stays`
// (`staysWithinScope(scope, new URL(url))`) -- over listed hosts with www/subdomain/case/trailing-dot
// variations, unlisted hosts, path-scoped prefixes and their siblings, and encoded `%2f`/`%5c`/`%2e`
// escapes (single, `%25`-repeated, truncated), with the answer recorded at the time.
import { expect, test } from "bun:test";
import { isPreapprovedHost, preapprovedScopeOf, staysWithinScope } from "./preapproved-hosts.ts";
import corpus from "./__corpus__/preapproved-hosts.json";

type Row =
  | { fn: "host"; hostname: string; pathname: string; expected: boolean }
  | { fn: "scope"; url: string; expected: { host: string; pathPrefix?: string } | null }
  | { fn: "stays"; scope: { host: string; pathPrefix?: string }; url: string; expected: boolean };

const answer = (row: Row): unknown => {
  if (row.fn === "host") return isPreapprovedHost(row.hostname, row.pathname);
  if (row.fn === "scope") return preapprovedScopeOf(new URL(row.url)) ?? null;
  return staysWithinScope(row.scope, new URL(row.url));
};

test("the recorded corpus answers exactly as recorded", () => {
  const rows = corpus as Row[];
  expect(rows.length).toBe(2971);
  const mismatches = rows.filter((row) => JSON.stringify(answer(row)) !== JSON.stringify(row.expected));
  expect(mismatches).toEqual([]);
});
