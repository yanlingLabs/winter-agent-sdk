// The loopback double for xAI's device-authorization endpoints. TEST-ONLY: nothing in a shipped
// path imports this file.
//
// Kept beside the adapter rather than in the conformance package for the reason `testing.ts` next
// door already states: both packages' fixtures need it and the dependency runs
// conformance -> provider-runtime, never the other way. `provider-conformance/src/fakes/xai-oauth.ts`
// re-exports it under the name the corpus uses.
//
// GROUND TRUTH IS `requests`. Every assertion about Winter's identity reads the request the server
// ACTUALLY RECEIVED, never the config object that produced it — a test that asserts on its own input
// passes just as happily against a flow that sends nothing.
//
// NO REAL CREDENTIALS. Every token here is `test-token-xai-…` and the account id is the fixture's
// own `acct-x`. Binds `127.0.0.1:0`; callers stop it in a `finally`.

/** Only what an assertion needs. Header names are lowercased; an `authorization` value would be redacted, though these two endpoints carry none. */
export interface XaiRecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  /** Raw form body. Bodies are not redacted: the body is exactly what the identity assertions are about. */
  body: string;
}

export interface XaiOauthFake {
  deviceCodeUrl: string;
  tokenUrl: string;
  requests: XaiRecordedRequest[];
  close(): Promise<void>;
}

export interface XaiOauthFakeOptions {
  /**
   * When the identity field arrives carrying THIS value, the token endpoint answers `access_denied`
   * — the vendor refusing an agent it does not recognise.
   *
   * It answers at the TOKEN endpoint, not the device endpoint, and that is deliberate rather than
   * convenient: RFC 8628 §3.5 is where `access_denied` lives, the device-authorization response
   * (§3.2) carries the RFC 6749 §5.2 set instead, and a real authorization server decides a consent
   * question when the authorization is finalized rather than when a code is minted. The device
   * endpoint still validates the field — it refuses a request that OMITS it (see below).
   */
  rejectIdentity?: string;
  /** How many polls answer `authorization_pending` before the token arrives. Default 0. */
  pendingPolls?: number;
  /** An ordinary terminal failure from the token endpoint (`expired_token`, …) — the negative that keeps `rejectIdentity` meaningful. */
  tokenError?: string;
  /** Omit the id token from the successful response, so the caller has no account id to name a record with (R6-10). */
  omitIdToken?: boolean;
}

const ACCOUNT_ID = "acct-x";

/** A JWT-shaped id token whose payload carries the standard OIDC `sub` claim. Unsigned — nothing here verifies a signature, and a real one would put a key in the repository. */
function fakeIdToken(sub: string = ACCOUNT_ID): string {
  const b64 = (value: unknown): string => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "ES256", typ: "JWT" })}.${b64({ sub, email: "someone@example.invalid" })}.c2ln`;
}

export async function startXaiOauthFake(opts: XaiOauthFakeOptions = {}): Promise<XaiOauthFake> {
  const requests: XaiRecordedRequest[] = [];
  let polls = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = await req.text();
      const headers: Record<string, string> = {};
      for (const [name, value] of req.headers) {
        headers[name.toLowerCase()] = /^(authorization|x-api-key|api-key)$/i.test(name) ? `${value.split(" ")[0] ?? ""} ***`.trim() : value;
      }
      requests.push({ method: req.method, path: url.pathname, headers, body });

      const form = new URLSearchParams(body);
      const identity = form.get("referrer");

      // THE HONEST-IDENTITY GUARD, on both endpoints: a flow that omits the field is refused here,
      // so "we send an identity" cannot pass by never sending one.
      if (identity === null || identity.length === 0) {
        return Response.json({ error: "invalid_request", error_description: "the client did not identify itself" }, { status: 400 });
      }

      if (url.pathname === "/oauth2/device/code") {
        return Response.json({
          device_code: "test-device-code-xai",
          user_code: "WXYZ-1234",
          verification_uri: "https://example.invalid/activate",
          verification_uri_complete: "https://example.invalid/activate?user_code=WXYZ-1234",
          interval: 0,
          expires_in: 900,
        });
      }

      if (url.pathname === "/oauth2/token") {
        if (opts.rejectIdentity !== undefined && identity === opts.rejectIdentity) {
          return Response.json({ error: "access_denied", error_description: "client not allowed" }, { status: 400 });
        }
        if (opts.tokenError !== undefined) {
          return Response.json({ error: opts.tokenError, error_description: "the fixture's ordinary failure" }, { status: 400 });
        }
        polls += 1;
        if (polls <= (opts.pendingPolls ?? 0)) return Response.json({ error: "authorization_pending" }, { status: 400 });
        return Response.json({
          access_token: "test-token-xai-access",
          refresh_token: "test-token-xai-refresh",
          ...(opts.omitIdToken === true ? {} : { id_token: fakeIdToken() }),
          expires_in: 3600,
          token_type: "Bearer",
        });
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });

  return {
    deviceCodeUrl: `http://127.0.0.1:${server.port}/oauth2/device/code`,
    tokenUrl: `http://127.0.0.1:${server.port}/oauth2/token`,
    requests,
    close: async () => {
      await server.stop(true);
    },
  };
}
