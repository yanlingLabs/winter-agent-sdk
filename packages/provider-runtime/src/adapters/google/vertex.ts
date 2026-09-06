// Phase 6 Task 6 (Lane B): Vertex Gemini -- `vertex-gemini@1` (R6-16, ruling R6-A).
//
// A TRANSPORT, NOT A SECOND ADAPTER. Vertex speaks the SAME GenerateContent dialect as the Gemini
// API, so it supplies only what differs -- a location-scoped URL and a Google Cloud credential --
// and `generate-content.ts` owns every line of the wire mapping and the normalizer. Ruling R6-A puts
// Vertex in this lane for exactly that reason, and the review rubric's "no duplicated wire mappings"
// is what this file is shaped to satisfy.
//
// THREE THINGS THAT ARE NOT OBVIOUS:
//
//   1. **There is no generated `defaultEndpoints` entry to inherit.** The host is
//      `<location>-aiplatform.googleapis.com`, so the endpoint does not exist until the connection
//      names a location -- which is why the catalog row's `defaultEndpoints` is empty and why the
//      URL is COMPOSED here. `project` and `location` are therefore validated against a strict
//      character class BEFORE interpolation: they arrive from host configuration, and an
//      unvalidated value in a URL path is a request-forgery primitive.
//
//   2. **The composed endpoint is treated as GENERATED, and an explicit `baseUrl` is not.** The
//      composed one is this file's own reviewed template with two validated fields substituted into
//      it -- the same standing as a descriptor endpoint. A `baseUrl` the host supplies is untrusted
//      input and gets the user-endpoint rules, which is what makes `x-goog-user-project` drop off a
//      request to it (R6-L) and what a loopback fixture rides.
//
//   3. **`validateCredential` and `listModels` answer "unsupported", not "fine".** This phase scopes
//      Vertex to the generation path; there is no bounded model-list endpoint here, so an empty
//      catalog is reported as PARTIAL (absence is never removal) and a credential that merely
//      RESOLVES is never reported as verified.
import type { ProviderAdapter, ProviderContext } from "../../types.ts";
import { ProviderRequestError } from "../../http.ts";
import { applyPrivilegedHeaders, createEndpointPolicy } from "../../endpoint-policy.ts";
import { hostHeaders } from "../privileged-headers.ts";
import { createGoogleFamilyAdapter, type GoogleAdapterOptions, type GoogleTransport } from "./generate-content.ts";
import { createAccessTokenSource, type AccessTokenSource, type AccessTokenSourceOptions } from "./adc.ts";

export const VERTEX_ADAPTER_ID = "winter.vertex-gemini";
/** The API version segment of the location endpoint. Vertex's GenerateContent surface is `v1`, not the Gemini API's `v1beta`. */
export const VERTEX_API_VERSION_PATH = "v1";

/**
 * `project` and `location` as they may appear in a URL path.
 *
 * A GCP project id is lowercase letters, digits and hyphens; a location is the same shape
 * (`us-central1`, `europe-west4`). Anything else -- a slash, a dot-dot, a percent escape, a space --
 * is refused rather than encoded, because a value that needs escaping to be safe in a path is a
 * value the host got wrong, and encoding it would send the request somewhere plausible-looking
 * instead of failing.
 */
const GCP_PATH_SEGMENT = /^[a-z0-9][a-z0-9-]{0,62}$/;

function refusal(reason: string): ProviderRequestError {
  return new ProviderRequestError({ code: "capability", message: reason, retryable: false });
}

export interface VertexAdapterOptions extends GoogleAdapterOptions, AccessTokenSourceOptions {}

/** Composes the location endpoint. Exported so a fixture can assert the exact URL the ruling names, without reaching the network. */
export function vertexEndpointUrl(location: string): string {
  return `https://${location}-aiplatform.googleapis.com`;
}

/** Composes the model path under a resolved base. Exported for the same reason. */
export function vertexModelPath(project: string, location: string, model: string, method: string, search = ""): string {
  return `/${VERTEX_API_VERSION_PATH}/projects/${project}/locations/${location}/publishers/google/models/${encodeURIComponent(model)}:${method}${search}`;
}

function requireSegment(value: string | undefined, field: string): string {
  if (value === undefined || value.length === 0) {
    throw refusal(`the Vertex connection needs a "${field}"; the location endpoint cannot be composed without it`);
  }
  if (!GCP_PATH_SEGMENT.test(value)) {
    throw refusal(`the Vertex connection's "${field}" is not a valid Google Cloud identifier (lowercase letters, digits and hyphens); Winter refuses to interpolate it into a request URL`);
  }
  return value;
}

export function vertexTransport(opts: VertexAdapterOptions = {}): GoogleTransport {
  // One source per credential REF, cached for the life of the adapter: a token exchange per turn
  // would triple the request count of every conversation, and the source itself caches the token
  // until it expires.
  const sources = new Map<string, AccessTokenSource>();

  function sourceKey(ctx: ProviderContext): string {
    const ref = ctx.authRef;
    switch (ref.kind) {
      case "keychain":
        return `keychain:${ref.service ?? ""}:${ref.account}`;
      case "env":
        return `env:${ref.name}`;
      case "file":
        return `file:${ref.path}:${ref.profile ?? ""}`;
      case "inline":
        // The VALUE is never part of the key: a cache key reaches memory dumps and, if it ever grew
        // a log line, a log. The kind alone is enough for a single-inline-credential session.
        return "inline";
      default:
        return ref.kind;
    }
  }

  return {
    id: VERTEX_ADAPTER_ID,
    version: "1",
    credentialKinds: ["gcp-service-account", "gcp-access-token"],

    endpoint(ctx) {
      const userBase = ctx.connection.baseUrl;
      if (userBase !== undefined) {
        const base = userBase.replace(/\/+$/, "");
        const built = createEndpointPolicy(base, { generated: false, ...(ctx.connection.local === true ? { local: true } : {}) });
        if (!built.ok) throw refusal(built.reason);
        return { base, policy: built.policy };
      }
      const location = requireSegment(ctx.connection.location, "location");
      requireSegment(ctx.connection.project, "project");
      const base = vertexEndpointUrl(location);
      const built = createEndpointPolicy(base, { generated: true });
      if (!built.ok) throw refusal(built.reason);
      return { base, policy: built.policy };
    },

    async headers(ctx, policy, json) {
      const material = await ctx.credentials.get(ctx.authRef);
      if (material === null) throw refusal("no Google Cloud credential is configured for this Vertex connection");
      const key = sourceKey(ctx);
      let source = sources.get(key);
      if (source === undefined) {
        source = createAccessTokenSource(material, { ...(opts.now !== undefined ? { now: opts.now } : {}), ...(ctx.connection.local === true ? { local: true } : {}) });
        if (source === undefined) {
          throw refusal(
            `the Vertex adapter cannot authenticate with credential material of kind "${material.kind}"; it needs a service-account JSON file ({ kind: "file", format: "gcp-service-account-json" }) or an explicit { kind: "gcp-access-token" }`,
          );
        }
        sources.set(key, source);
      }
      const token = await source.token();
      // HOST HEADERS FIRST, so nothing below can be silently overridden -- a host header spread LAST
      // could replace `content-type`, or (for Vertex) the bearer token this transport just minted.
      //
      // AND FILTERED, which is the other half of R6-L: `applyPrivilegedHeaders` gates the set the
      // ADAPTER builds, but it cannot remove a name from a map it never saw -- so a host writing
      // `x-goog-user-project` into its own `connection.headers` put the operator's account topology
      // on a user endpoint straight past the rule. R6-L is strict as written: a user endpoint that
      // legitimately needs an organisation header must be marked GENERATED by the host.
      return {
        ...hostHeaders(policy, ctx.connection.headers),
        authorization: `Bearer ${token}`,
        ...(json ? { "content-type": "application/json" } : {}),
        // PRIVILEGED (R6-L): an account identifier. It rides the composed, reviewed endpoint and is
        // dropped for a user-supplied `baseUrl`.
        ...applyPrivilegedHeaders(policy, ctx.connection.project !== undefined ? { "x-goog-user-project": ctx.connection.project } : {}),
      };
    },

    streamPath: (ctx, model) => vertexModelPath(requireSegment(ctx.connection.project, "project"), requireSegment(ctx.connection.location, "location"), model, "streamGenerateContent", "?alt=sse"),
    countTokensPath: (ctx, model) => vertexModelPath(requireSegment(ctx.connection.project, "project"), requireSegment(ctx.connection.location, "location"), model, "countTokens"),
    // `listPath` is ABSENT, and `generate-content.ts` reads that absence as "this transport cannot
    // enumerate" -- an empty catalog marked PARTIAL and a credential reported `unsupported` rather
    // than verified. Claiming either would be a claim nothing checked.
  };
}

/** The Vertex adapter: the shared GenerateContent mapping over the Vertex transport. */
export function createVertexGeminiAdapter(opts: VertexAdapterOptions = {}): ProviderAdapter {
  return createGoogleFamilyAdapter(vertexTransport(opts), opts);
}
