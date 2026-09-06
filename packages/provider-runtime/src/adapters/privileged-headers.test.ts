// R6-L's host-header filter, and the fix wave's addition to it (whole-branch review M-1).
//
// `hostHeaders` is the enforcement point FOUR of the five families share (Bedrock's signer needs its
// own filter and keeps one, wired to the same constant). Two rules point in OPPOSITE directions, and
// this file exists because a reader who only sees one of them will get the other backwards:
//
//   PRIVILEGED names are dropped on a USER endpoint and kept on a generated one — the reviewed
//     descriptor endpoint vouches for the account identifiers minted for it.
//   WINTER'S IDENTITY names are dropped on a GENERATED endpoint and kept on a user one — the one
//     sanctioned override is the operator describing their own proxy (`identity.ts`'s own words),
//     and the vendor's own endpoint is exactly where presenting Winter as something else matters.
//
// Credentials are dropped on both, always.

import { describe, expect, test } from "bun:test";
import { createEndpointPolicy, type EndpointPolicy } from "../endpoint-policy.ts";
import { hostHeaders, PRIVILEGED_IDENTITY_HEADERS, WINTER_IDENTITY_HEADERS } from "./privileged-headers.ts";

function policy(generated: boolean): EndpointPolicy {
  const built = createEndpointPolicy("https://vendor.example", { generated });
  if (!built.ok) throw new Error(built.reason);
  return built.policy;
}

describe("hostHeaders: R6-L, and M-1's inverse rule for Winter's own identity", () => {
  test("a profile `user-agent` is DROPPED on a generated (vendor) endpoint — the override is for the operator's own proxy", () => {
    // The defect: `identity.ts` says the User-Agent is "deliberately NOT configurable" and names one
    // sanctioned override, "the operator speaking about their own proxy". Nothing enforced the
    // second half, so the same profile field replaced Winter's identity at the VENDOR'S endpoint —
    // the one place the admission rule is about.
    expect(hostHeaders(policy(true), { "user-agent": "some-editor/1.2.3", "client-agent": "some-editor:1.2.3:x@example", "x-trace-id": "keep-me" })).toEqual({ "x-trace-id": "keep-me" });
  });

  test("...and KEPT on a user endpoint — a host describing its own proxy is the sanctioned override, not a hole", () => {
    // The negative half. A rule that dropped the header everywhere would pass the test above while
    // removing a legitimate capability, and would look identical from that test alone.
    expect(hostHeaders(policy(false), { "user-agent": "my-proxy/1.0", "client-agent": "my-proxy:1.0:ops@example" })).toEqual({ "user-agent": "my-proxy/1.0", "client-agent": "my-proxy:1.0:ops@example" });
  });

  test("the two rules point OPPOSITE ways, which is the thing most likely to be 'simplified' back into one", () => {
    const org = PRIVILEGED_IDENTITY_HEADERS.find((name) => name === "x-goog-quota-project")!;
    // `x-goog-quota-project` is the one privileged name that is NOT also credential-shaped, so it is
    // the only header where the privileged rule is observable on its own.
    expect(Object.keys(hostHeaders(policy(true), { [org]: "proj-1", "user-agent": "editor/1" }))).toEqual([org]);
    expect(Object.keys(hostHeaders(policy(false), { [org]: "proj-1", "user-agent": "editor/1" }))).toEqual(["user-agent"]);
  });

  test("the match is CASE-INSENSITIVE — a profile spelling `User-Agent` is the same override", () => {
    // Header names are case-insensitive on the wire but not in a plain object, and `User-Agent` is
    // the spelling a host is most likely to write.
    expect(hostHeaders(policy(true), { "User-Agent": "some-editor/1.2.3" })).toEqual({});
  });

  test("credentials are dropped on BOTH — the older rule is untouched by M-1", () => {
    for (const generated of [true, false]) {
      expect(hostHeaders(policy(generated), { authorization: "Bearer x", cookie: "a=b", "x-trace-id": "keep-me" })).toEqual({ "x-trace-id": "keep-me" });
    }
  });

  test("the constant is the whole list, so Bedrock's own filter cannot drift from this one", () => {
    // `converse.ts` reads `WINTER_IDENTITY_HEADERS` rather than keeping a second copy: its signer
    // needs its own filter (the `x-amz-*` and `host` rules), and a second list of identity names is
    // how the two families would come to disagree.
    expect([...WINTER_IDENTITY_HEADERS]).toEqual(["user-agent", "client-agent"]);
  });
});
