import { describe, expect, test } from "bun:test";
import {
  BEDROCK_SERVICE,
  awsUriEncode,
  buildCanonicalRequest,
  buildStringToSign,
  canonicalQuery,
  canonicalUri,
  computeSignature,
  parseAuthorization,
  sha256Hex,
  signRequest,
} from "./sigv4.ts";
import { verifySigV4 } from "./testing.ts";

// KNOWN-ANSWER TESTS. Every `EXPECTED_*` constant below was computed by a PYTHON implementation of
// the documented SigV4 algorithm (`hashlib`/`hmac`/`urllib.parse`), written independently of this
// TypeScript one. `EXPECTED_GET_VANILLA` is additionally AWS's OWN published answer for the
// `get-vanilla` case of its signing test suite -- so two independent sources agree on it, which is
// what makes the whole chain (canonical request, string-to-sign, key derivation, final HMAC)
// evidence rather than a restatement of `sigv4.ts`.
//
// THE CREDENTIALS ARE AWS'S OWN DOCUMENTATION EXAMPLES (`AKIDEXAMPLE`), published in the signing
// test suite for exactly this purpose. They authenticate nothing.
const TEST_ACCESS_KEY = "AKIDEXAMPLE";
const TEST_SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

const EXPECTED_GET_VANILLA = "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31";
const EXPECTED_BEDROCK = "a666f00f5bae4f38f93df561f59a840e526d6fad8839e8b193f23c0fa8d9b34d";
const EXPECTED_BEDROCK_WITH_SESSION_TOKEN = "f276b3fdd9e520e94e49bddbdc28f30b76e05dedd5c8518ed4ab5055b4f442e7";
const EXPECTED_LIST_MODELS = "cdce1ead5c5c586f5d3e83bc1045c1aa7d27bdbb53769cf49a6811d2b3784769";

const BEDROCK_MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";
const BEDROCK_URL = `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(BEDROCK_MODEL_ID)}/converse-stream`;
const BEDROCK_BODY = new TextEncoder().encode('{"messages":[{"role":"user","content":[{"text":"hi"}]}]}');
const BEDROCK_DATE = new Date("2026-09-05T00:00:00.000Z");

describe("SigV4 known-answer vectors", () => {
  test("AWS's own get-vanilla case: canonical request, string-to-sign and signature all reproduce", async () => {
    const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
      method: "GET",
      pathname: "/",
      search: "",
      headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
      payloadHash: await sha256Hex(new Uint8Array(0)),
    });
    // The exact string AWS's documentation prints for this case.
    expect(canonicalRequest).toBe(
      ["GET", "/", "", "host:example.amazonaws.com", "x-amz-date:20150830T123600Z", "", "host;x-amz-date", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"].join("\n"),
    );
    expect(signedHeaders).toBe("host;x-amz-date");

    const stringToSign = await buildStringToSign(canonicalRequest, "20150830T123600Z", "20150830/us-east-1/service/aws4_request");
    expect(stringToSign).toBe(
      ["AWS4-HMAC-SHA256", "20150830T123600Z", "20150830/us-east-1/service/aws4_request", "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63"].join("\n"),
    );
    expect(await computeSignature(TEST_SECRET, "20150830", "us-east-1", "service", stringToSign)).toBe(EXPECTED_GET_VANILLA);
  });

  test("a Bedrock converse-stream request signs to the Python oracle's answer", async () => {
    const signed = await signRequest({
      method: "POST",
      url: BEDROCK_URL,
      headers: { "content-type": "application/json" },
      body: BEDROCK_BODY,
      credentials: { accessKeyId: TEST_ACCESS_KEY, secretAccessKey: TEST_SECRET },
      region: "us-east-1",
      date: BEDROCK_DATE,
    });
    expect(signed.signature).toBe(EXPECTED_BEDROCK);
    expect(signed.signedHeaders).toBe("content-type;host;x-amz-content-sha256;x-amz-date");
    expect(signed.headers["authorization"]).toBe(
      `AWS4-HMAC-SHA256 Credential=${TEST_ACCESS_KEY}/20260905/us-east-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=${EXPECTED_BEDROCK}`,
    );
  });

  test("THE MODEL ID'S COLON IS ENCODED TWICE in the canonical URI", async () => {
    // The single detail most likely to be wrong and least likely to be noticed: sign the
    // ONCE-encoded path and every real Bedrock request 403s. The URL carries `%3A`; the canonical
    // URI carries `%253A`.
    expect(BEDROCK_URL).toContain("v2%3A0");
    const signed = await signRequest({
      method: "POST",
      url: BEDROCK_URL,
      headers: { "content-type": "application/json" },
      body: BEDROCK_BODY,
      credentials: { accessKeyId: TEST_ACCESS_KEY, secretAccessKey: TEST_SECRET },
      region: "us-east-1",
      date: BEDROCK_DATE,
    });
    expect(signed.canonicalRequest.split("\n")[1]).toBe("/model/anthropic.claude-3-5-sonnet-20241022-v2%253A0/converse-stream");
    expect(canonicalUri("/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/converse-stream")).toBe(
      "/model/anthropic.claude-3-5-sonnet-20241022-v2%253A0/converse-stream",
    );
  });

  test("a session token joins the signed headers and changes the signature", async () => {
    const signed = await signRequest({
      method: "POST",
      url: BEDROCK_URL,
      headers: { "content-type": "application/json" },
      body: BEDROCK_BODY,
      credentials: { accessKeyId: TEST_ACCESS_KEY, secretAccessKey: TEST_SECRET, sessionToken: "FAKE-SESSION-TOKEN" },
      region: "us-east-1",
      date: BEDROCK_DATE,
    });
    expect(signed.signedHeaders).toBe("content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token");
    expect(signed.signature).toBe(EXPECTED_BEDROCK_WITH_SESSION_TOKEN);
    expect(signed.signature).not.toBe(EXPECTED_BEDROCK);
    expect(signed.headers["x-amz-security-token"]).toBe("FAKE-SESSION-TOKEN");
  });

  test("a GET with a query string sorts and encodes it canonically", async () => {
    const signed = await signRequest({
      method: "GET",
      // Deliberately supplied UNSORTED: the canonical form must sort by name, and a signer that
      // simply echoed `url.search` would produce a different signature from the oracle's.
      url: "https://bedrock.us-east-1.amazonaws.com/foundation-models?byProvider=anthropic&byOutputModality=TEXT",
      headers: {},
      body: new Uint8Array(0),
      credentials: { accessKeyId: TEST_ACCESS_KEY, secretAccessKey: TEST_SECRET },
      region: "us-east-1",
      date: BEDROCK_DATE,
    });
    expect(signed.canonicalRequest.split("\n")[2]).toBe("byOutputModality=TEXT&byProvider=anthropic");
    expect(signed.signature).toBe(EXPECTED_LIST_MODELS);
  });
});

describe("the signing pieces", () => {
  test("awsUriEncode escapes everything outside the unreserved set, and honours encodeSlash", () => {
    expect(awsUriEncode("a-b_c.d~e", true)).toBe("a-b_c.d~e");
    expect(awsUriEncode("a/b", false)).toBe("a/b");
    expect(awsUriEncode("a/b", true)).toBe("a%2Fb");
    expect(awsUriEncode("v2:0", true)).toBe("v2%3A0");
    expect(awsUriEncode(" ", true)).toBe("%20");
    // Multi-byte input is encoded per BYTE, not per code point.
    expect(awsUriEncode("é", true)).toBe("%C3%A9");
  });

  test("canonicalUri normalizes . and .. segments and never returns an empty path", () => {
    expect(canonicalUri("")).toBe("/");
    expect(canonicalUri("/")).toBe("/");
    expect(canonicalUri("/a/./b")).toBe("/a/b");
    expect(canonicalUri("/a/b/../c")).toBe("/a/c");
    expect(canonicalUri("/a/b/")).toBe("/a/b/");
  });

  test("canonicalQuery sorts by name and then by value", () => {
    expect(canonicalQuery("?b=2&a=1")).toBe("a=1&b=2");
    expect(canonicalQuery("?a=2&a=1")).toBe("a=1&a=2");
    expect(canonicalQuery("")).toBe("");
  });

  test("canonical header values are trimmed and their internal whitespace collapsed", async () => {
    const { canonicalRequest } = buildCanonicalRequest({
      method: "GET",
      pathname: "/",
      search: "",
      headers: { "X-Test": "  a   b  ", host: "example.com" },
      payloadHash: await sha256Hex(new Uint8Array(0)),
    });
    expect(canonicalRequest).toContain("x-test:a b\n");
  });

  test("parseAuthorization round-trips a signed header, and refuses a malformed one", async () => {
    const signed = await signRequest({
      method: "POST",
      url: BEDROCK_URL,
      headers: { "content-type": "application/json" },
      body: BEDROCK_BODY,
      credentials: { accessKeyId: TEST_ACCESS_KEY, secretAccessKey: TEST_SECRET },
      region: "us-east-1",
      date: BEDROCK_DATE,
    });
    const parsed = parseAuthorization(signed.headers["authorization"]);
    expect(parsed).toEqual({
      accessKeyId: TEST_ACCESS_KEY,
      datestamp: "20260905",
      region: "us-east-1",
      service: BEDROCK_SERVICE,
      signedHeaders: ["content-type", "host", "x-amz-content-sha256", "x-amz-date"],
      signature: EXPECTED_BEDROCK,
    });
    expect(parseAuthorization(undefined)).toBeUndefined();
    expect(parseAuthorization("Bearer sk-nope")).toBeUndefined();
    expect(parseAuthorization("AWS4-HMAC-SHA256 Credential=a/b/c/d/WRONG, SignedHeaders=host, Signature=x")).toBeUndefined();
  });
});

describe("verifySigV4 (the check the conformance fake performs)", () => {
  async function verify(overrides: { body?: Uint8Array; secret?: string; mutate?: (h: Headers) => void } = {}): Promise<{ ok: boolean; reason?: string }> {
    const signed = await signRequest({
      method: "POST",
      url: BEDROCK_URL,
      headers: { "content-type": "application/json" },
      body: BEDROCK_BODY,
      credentials: { accessKeyId: TEST_ACCESS_KEY, secretAccessKey: TEST_SECRET },
      region: "us-east-1",
      date: BEDROCK_DATE,
    });
    const headers = new Headers({ "content-type": "application/json", ...signed.headers });
    overrides.mutate?.(headers);
    const verdict = await verifySigV4({
      method: "POST",
      url: BEDROCK_URL,
      headers,
      body: overrides.body ?? BEDROCK_BODY,
      secretAccessKey: overrides.secret ?? TEST_SECRET,
    });
    return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
  }

  test("accepts a correctly signed request", async () => {
    expect(await verify()).toEqual({ ok: true });
  });

  // THE GUARD ON THE GUARD. Without these four negatives every signature assertion in the corpus
  // would be vacuous: a verifier that returned `ok` unconditionally would pass the case above.
  test("REJECTS a request signed with the wrong secret", async () => {
    const verdict = await verify({ secret: "a-different-secret" });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("does not match");
  });

  test("REJECTS a request whose body was swapped after signing", async () => {
    const verdict = await verify({ body: new TextEncoder().encode('{"messages":[]}') });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("x-amz-content-sha256");
  });

  test("REJECTS a request whose signed header was altered after signing", async () => {
    const verdict = await verify({ mutate: (h) => h.set("content-type", "text/plain") });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("does not match");
  });

  test("REJECTS a request carrying no Authorization header at all", async () => {
    const verdict = await verify({ mutate: (h) => h.delete("authorization") });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("no parseable");
  });

  test("REJECTS an unknown access key id before doing any crypto", async () => {
    const signed = await signRequest({
      method: "POST",
      url: BEDROCK_URL,
      headers: { "content-type": "application/json" },
      body: BEDROCK_BODY,
      credentials: { accessKeyId: "AKIDSOMEONEELSE", secretAccessKey: TEST_SECRET },
      region: "us-east-1",
      date: BEDROCK_DATE,
    });
    const verdict = await verifySigV4({
      method: "POST",
      url: BEDROCK_URL,
      headers: new Headers({ "content-type": "application/json", ...signed.headers }),
      body: BEDROCK_BODY,
      secretAccessKey: TEST_SECRET,
      expectedAccessKeyId: TEST_ACCESS_KEY,
    });
    expect(verdict.ok).toBe(false);
  });

  test("the port is part of the signed host: a signature taken for one authority fails for another", async () => {
    // `url.host` vs `url.hostname`. This is the difference that would make every loopback fixture
    // fail while real AWS worked, or the reverse -- so it is pinned rather than assumed.
    const signed = await signRequest({
      method: "POST",
      url: "http://127.0.0.1:4321/model/m/converse-stream",
      headers: {},
      body: BEDROCK_BODY,
      credentials: { accessKeyId: TEST_ACCESS_KEY, secretAccessKey: TEST_SECRET },
      region: "us-east-1",
      date: BEDROCK_DATE,
    });
    expect(signed.canonicalRequest).toContain("host:127.0.0.1:4321");
    const wrongPort = await verifySigV4({
      method: "POST",
      url: "http://127.0.0.1:9999/model/m/converse-stream",
      headers: new Headers(signed.headers),
      body: BEDROCK_BODY,
      secretAccessKey: TEST_SECRET,
    });
    expect(wrongPort.ok).toBe(false);
  });
});
