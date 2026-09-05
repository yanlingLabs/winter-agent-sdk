import { describe, expect, test } from "bun:test";
import { classifyAddress } from "./address-classifier.ts";
import { CREDENTIAL_HEADER_NAMES, createEndpointPolicy, evaluateEndpoint, stripCredentialHeaders } from "./endpoint-policy.ts";

function reasonOf(result: ReturnType<typeof evaluateEndpoint>): string {
  if (result.ok) throw new Error("expected a refusal, got an acceptance");
  return result.reason;
}

describe("evaluateEndpoint — scheme and shape", () => {
  test("accepts an ordinary https endpoint and reports its origin", () => {
    const result = evaluateEndpoint("https://api.example.test/v1", { generated: false });
    expect(result).toEqual({ ok: true, origin: "https://api.example.test", local: false });
  });

  test("the origin drops the path — it is the credential boundary, not the URL", () => {
    const result = evaluateEndpoint("https://api.example.test:8443/v1/deep/path", { generated: false });
    expect(result.ok && result.origin).toBe("https://api.example.test:8443");
  });

  test("refuses an unparseable URL and a relative one", () => {
    expect(reasonOf(evaluateEndpoint("not a url", { generated: false }))).toContain("not a parseable absolute URL");
    expect(reasonOf(evaluateEndpoint("/v1", { generated: false }))).toContain("not a parseable absolute URL");
  });

  test("refuses every scheme but http/https — file:, data: and ftp: are not endpoints", () => {
    for (const url of ["file:///etc/passwd", "data:text/plain,hi", "ftp://example.test/x", "ws://example.test/x"]) {
      expect(reasonOf(evaluateEndpoint(url, { generated: false }))).toContain("unsupported scheme");
    }
  });

  test("refuses userinfo — a credential must never ride a URL", () => {
    expect(reasonOf(evaluateEndpoint("https://user:pw@api.example.test/v1", { generated: false }))).toContain("userinfo");
  });

  test("refuses a query string or fragment on a base URL", () => {
    // Gemini's own `?key=` surface is exactly this shape: a base URL carrying a credential in its
    // query would reach every log line, every error message and every telemetry record verbatim.
    expect(reasonOf(evaluateEndpoint("https://api.example.test/v1?key=test-key-abc", { generated: false }))).toContain("query string");
    expect(reasonOf(evaluateEndpoint("https://api.example.test/v1#frag", { generated: false }))).toContain("fragment");
  });
});

describe("evaluateEndpoint — the local/private split (R6-11, WS-13 §13)", () => {
  test("refuses a USER endpoint pointing at a private address that was not declared local", () => {
    for (const host of ["127.0.0.1", "10.0.0.5", "192.168.1.9", "169.254.169.254", "[::1]", "[fe80::1]"]) {
      const reason = reasonOf(evaluateEndpoint(`https://${host}/v1`, { generated: false }));
      expect(reason).toContain("not declared local");
    }
  });

  test("ACCEPTS the same address when the host declares the connection local, and says so in the result", () => {
    const result = evaluateEndpoint("http://127.0.0.1:11434/v1", { generated: false, local: true });
    expect(result).toEqual({ ok: true, origin: "http://127.0.0.1:11434", local: true });
  });

  test("`localhost` is treated as loopback without a DNS lookup", () => {
    // evaluateEndpoint is SYNCHRONOUS by contract, so it cannot resolve a name. `localhost` is the
    // one name with a universally reserved meaning (RFC 6761); every other name is left unresolved
    // and therefore cannot be marked local.
    expect(evaluateEndpoint("http://localhost:1234/v1", { generated: false, local: true })).toEqual({ ok: true, origin: "http://localhost:1234", local: true });
    expect(reasonOf(evaluateEndpoint("http://localhost:1234/v1", { generated: false }))).toContain("not declared local");
  });

  test("a DNS NAME can never be marked local, even when the caller declares it", () => {
    // The whole point: a name resolves at connect time, so "this name is local" is a claim this
    // function cannot check and a rebinding resolver could falsify. `local: true` only ever
    // relaxes the policy for a LITERAL address the classifier itself just judged.
    const reason = reasonOf(evaluateEndpoint("http://internal.corp.example/v1", { generated: false, local: true }));
    expect(reason).toContain("plain http");
  });

  test("refuses plain http to a public address, generated or not", () => {
    expect(reasonOf(evaluateEndpoint("http://api.example.test/v1", { generated: false }))).toContain("plain http");
    expect(reasonOf(evaluateEndpoint("http://api.example.test/v1", { generated: true }))).toContain("plain http");
    expect(reasonOf(evaluateEndpoint("http://93.184.216.34/v1", { generated: true }))).toContain("plain http");
  });

  test("a GENERATED endpoint may be http on a local address — that is the twelve local providers' shape", () => {
    // Generated endpoints are immutable and reviewed (R6-11), so a reviewed loopback endpoint is by
    // definition sanctioned; the local providers' own descriptors are all http://127.0.0.1.
    const result = evaluateEndpoint("http://127.0.0.1:11434/v1", { generated: true });
    expect(result).toEqual({ ok: true, origin: "http://127.0.0.1:11434", local: true });
  });

  test("refuses multicast, unspecified and carrier-grade-NAT addresses outright — `local` does not rescue them", () => {
    for (const host of ["224.0.0.1", "0.0.0.0", "100.64.0.1"]) {
      const reason = reasonOf(evaluateEndpoint(`http://${host}/v1`, { generated: false, local: true }));
      expect(reason).toContain(classifyAddress(host, 4));
    }
  });

  test("cloud metadata (169.254.169.254) is reachable ONLY as an explicitly declared local endpoint", () => {
    expect(reasonOf(evaluateEndpoint("http://169.254.169.254/latest/meta-data", { generated: false }))).toContain("not declared local");
    // And even then it is link-local, not something a generated descriptor could ever name: the
    // acceptance below is the host taking explicit responsibility, which is the design.
    expect(evaluateEndpoint("http://169.254.169.254/v1", { generated: false, local: true }).ok).toBe(true);
  });
});

describe("createEndpointPolicy — redirect revalidation (R6-11: no credential forwarding across an origin change)", () => {
  test("builds a policy pinned to the accepted origin", () => {
    const created = createEndpointPolicy("https://api.example.test/v1", { generated: true });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.reason);
    expect(created.policy.origin).toBe("https://api.example.test");
    expect(created.policy.local).toBe(false);
    expect(created.policy.generated).toBe(true);
  });

  test("a SAME-origin redirect keeps credentials", () => {
    const created = createEndpointPolicy("https://api.example.test/v1", { generated: true });
    if (!created.ok) throw new Error(created.reason);
    const verdict = created.policy.evaluateRedirect("https://api.example.test/v1/other");
    expect(verdict).toEqual({ ok: true, origin: "https://api.example.test", sameOrigin: true });
  });

  test("a CROSS-origin redirect is allowed only if it passes the policy itself, and never carries credentials", () => {
    const created = createEndpointPolicy("https://api.example.test/v1", { generated: true });
    if (!created.ok) throw new Error(created.reason);
    const verdict = created.policy.evaluateRedirect("https://cdn.example.test/v1");
    expect(verdict).toEqual({ ok: true, origin: "https://cdn.example.test", sameOrigin: false });
  });

  test("a redirect to a private address from a NON-local policy is refused — the classic SSRF pivot", () => {
    const created = createEndpointPolicy("https://api.example.test/v1", { generated: true });
    if (!created.ok) throw new Error(created.reason);
    const verdict = created.policy.evaluateRedirect("http://169.254.169.254/latest/meta-data");
    expect(verdict.ok).toBe(false);
  });

  test("a redirect from a LOCAL policy out to a public address is still evaluated, not waved through", () => {
    const created = createEndpointPolicy("http://127.0.0.1:11434/v1", { generated: false, local: true });
    if (!created.ok) throw new Error(created.reason);
    // http to a public host fails the scheme rule, `local` or not: the declaration described the
    // ORIGINAL endpoint, and a redirect is a different endpoint.
    expect(created.policy.evaluateRedirect("http://api.example.test/v1").ok).toBe(false);
    expect(created.policy.evaluateRedirect("https://api.example.test/v1")).toEqual({ ok: true, origin: "https://api.example.test", sameOrigin: false });
  });

  test("a LOCAL policy may follow a SAME-ORIGIN hop but never pivots into the rest of the private space", () => {
    // The host declared ONE local endpoint. A local server redirecting the client to cloud metadata
    // (or to a neighbour on the LAN) is a request the host never authorised, and carrying the
    // `local: true` declaration across a cross-origin hop is exactly how that would slip through.
    const created = createEndpointPolicy("http://127.0.0.1:11434/v1", { generated: false, local: true });
    if (!created.ok) throw new Error(created.reason);
    expect(created.policy.evaluateRedirect("http://127.0.0.1:11434/v1/chat")).toEqual({ ok: true, origin: "http://127.0.0.1:11434", sameOrigin: true });
    // Another PORT on the same machine is an ordinary local reverse-proxy hop: allowed, but still
    // cross-origin, so the caller must drop credentials.
    expect(created.policy.evaluateRedirect("http://127.0.0.1:9999/v1")).toEqual({ ok: true, origin: "http://127.0.0.1:9999", sameOrigin: false });
    // Another MACHINE is not: cloud metadata and LAN neighbours stay refused.
    expect(created.policy.evaluateRedirect("http://169.254.169.254/latest/meta-data").ok).toBe(false);
    expect(created.policy.evaluateRedirect("http://192.168.1.9/v1").ok).toBe(false);
    expect(created.policy.evaluateRedirect("http://10.0.0.5/v1").ok).toBe(false);
  });

  test("refuses a relative or unparseable redirect target rather than guessing at a base", () => {
    const created = createEndpointPolicy("https://api.example.test/v1", { generated: true });
    if (!created.ok) throw new Error(created.reason);
    expect(created.policy.evaluateRedirect("/elsewhere").ok).toBe(false);
  });
});

describe("stripCredentialHeaders", () => {
  test("removes every credential-bearing header, case-insensitively, and keeps the rest", () => {
    const headers = new Headers({
      authorization: "Bearer test-key-abc",
      "x-api-key": "test-key-abc",
      "api-key": "test-key-abc",
      cookie: "session=test-key-abc",
      "proxy-authorization": "Basic dGVzdC1rZXk=",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    });
    const stripped = stripCredentialHeaders(headers);
    for (const name of CREDENTIAL_HEADER_NAMES) expect(stripped.has(name)).toBe(false);
    expect(stripped.get("content-type")).toBe("application/json");
    // A non-secret protocol header survives: dropping it would break the request for no benefit.
    expect(stripped.get("anthropic-version")).toBe("2023-06-01");
  });

  test("does not mutate the headers it was given", () => {
    const headers = new Headers({ authorization: "Bearer test-key-abc" });
    stripCredentialHeaders(headers);
    expect(headers.get("authorization")).toBe("Bearer test-key-abc");
  });
});
