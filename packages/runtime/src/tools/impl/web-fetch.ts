// "WebFetch" -- the REAL executor, replacing `descriptors/web-fetch.ts`'s stub.
//
// ORDER OF OPERATIONS (pinned so a reviewer can check this file against it in one pass):
//   parse input -> `new URL()` -> web session runtime wired? -> domain floor on the input host ->
//   private-address policy on the input host -> cache lookup -> (miss) the local fetch, which
//   re-applies the floor AND the private-address policy on EVERY redirect hop
//   (`_web-fetch-net.ts`'s own loop) -> convert (html/text/binary) -> preapproved verbatim
//   passthrough, or the digest pass -> the registry's own 50,000-char result cap (this registry
//   enforces none itself, so it is applied here).
//
// A FIX LANE IS REPAIRING TWO SPINE BUGS IN PARALLEL (not edited here, per this lane's own scope):
//   1. `resolveWebToolsConfig` does not validate `privateAddressPolicy` at runtime (config arrives as
//      untyped JSON) -- `normalizePrivateAddressPolicy` below fails CLOSED: only the exact string
//      `"allow"` is treated as allow, `"deny"` is deny, everything else (including an unrecognised
//      value) behaves as `"ask"`.
//   2. `runInnerModel` can currently throw when its auxiliary-model resolver throws -- the digest
//      call below is wrapped in its own try/catch regardless, and a caught throw is reported by the
//      error's NAME only, NEVER its message (a probe upstream leaked a secret-shaped message that
//      way).
// Both are disclosed in the report; neither spine file is touched here.
import "../descriptors/web-fetch.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { lookup as dnsLookup } from "node:dns/promises";
import { join } from "node:path";
import { WINTER_BRAND, type WebPrivateAddressPolicy } from "@yanlinglabs/winter-agent-sdk";
import { winterUserAgent } from "@yanlinglabs/winter-provider-runtime";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { webSessionRuntimeFor, type WebSessionRuntime } from "../../web/session-runtime.ts";
import { isDomainBlocked } from "./_domains.ts";
import { classifyHostname } from "../../web/private-address.ts";
import { isPreapprovedUrl } from "../../web/preapproved-hosts.ts";
import { convertFetchedHtml, WEB_FETCH_HTML_TRUNCATION_NOTICE } from "./_web-fetch-html.ts";
import { webFetchCache, WebFetchCache, type WebFetchCacheEntry } from "./_web-fetch-cache.ts";
import { performWebFetch, WEB_FETCH_TIMEOUT_MS, type NormalizedPrivateAddressPolicy, type WebFetchNetDeps } from "./_web-fetch-net.ts";
import { runInnerModel, type InnerModelFailureCode } from "./_inner-model.ts";

const DIGEST_CONTENT_CAP = 100_000;
const RESULT_CAP = 50_000;

const PERMISSIVE_GUIDELINES = "Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.";
const STRICT_GUIDELINES = `Provide a concise response based only on the content above. In your response:
 - Enforce a strict 125-character maximum for quotes from any source document. Open Source Software is ok as long as we respect the license.
 - Use quotation marks for exact language from articles; any language outside of the quotation should never be word-for-word the same.
 - You are not a lawyer and never comment on the legality of your own prompts and responses.
 - Never produce or reproduce exact song lyrics.`;

// --- input validation --------------------------------------------------------------------------------

interface WebFetchInput {
  url: string;
  prompt: string;
}

function parseInput(raw: unknown): WebFetchInput | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "input must be an object" };
  const o = raw as Record<string, unknown>;
  const url = o["url"];
  const prompt = o["prompt"];
  if (typeof url !== "string" || url.length === 0) return { error: "url must be a non-empty string" };
  if (typeof prompt !== "string") return { error: "prompt must be a string" };
  return { url, prompt };
}

function invalidUrlMessage(raw: string): string {
  return `Invalid URL "${raw}". The URL provided could not be parsed.`;
}

/** Fails CLOSED (see the module header): only the exact string `"allow"` is treated as allow. */
function normalizePrivateAddressPolicy(policy: WebPrivateAddressPolicy | string | undefined): NormalizedPrivateAddressPolicy {
  if (policy === "allow") return "allow";
  if (policy === "deny") return "deny";
  return "ask";
}

function brandNameFor(ctx: ToolExecutionContext): string {
  return ctx.brand?.productName ?? WINTER_BRAND.productName;
}

function capResult(text: string): string {
  if (text.length <= RESULT_CAP) return text;
  return `${text.slice(0, RESULT_CAP)}\n\n[Result truncated at ${RESULT_CAP.toLocaleString("en-US")} characters.]`;
}

// --- content classification ---------------------------------------------------------------------------

type ContentKind = "html" | "text" | "binary";

function classifyContentType(contentType: string): ContentKind {
  const ct = contentType.toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/xhtml+xml")) return "html";
  if (ct === "" || ct.startsWith("text/") || ct.includes("json") || ct.includes("xml") || ct.includes("javascript") || ct.includes("csv")) return "text";
  return "binary";
}

function sanitizeFilenameSegment(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return cleaned.length > 0 ? cleaned : "download";
}

async function saveBinaryToTemp(ctx: ToolExecutionContext, url: URL, bytes: Uint8Array): Promise<string | undefined> {
  if (typeof ctx.tempDir !== "string" || ctx.tempDir.length === 0) return undefined;
  const lastSegment = url.pathname.split("/").filter((s) => s.length > 0).pop() ?? "download";
  const filename = `webfetch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${sanitizeFilenameSegment(lastSegment)}`;
  const path = join(ctx.tempDir, filename);
  try {
    await mkdir(ctx.tempDir, { recursive: true });
    await writeFile(path, bytes);
    return path;
  } catch {
    return undefined;
  }
}

// --- the digest pass -----------------------------------------------------------------------------

function digestPrompt(content: string, prompt: string, guidelines: string): string {
  return `\nWeb page content:\n---\n${content}\n---\n\n${prompt}\n\n${guidelines}\n`;
}

function cappedForDigest(content: string): string {
  return content.length > DIGEST_CONTENT_CAP ? content.slice(0, DIGEST_CONTENT_CAP) + WEB_FETCH_HTML_TRUNCATION_NOTICE : content;
}

function digestFailureMessage(code: InnerModelFailureCode, message: string): string {
  switch (code) {
    case "not-wired":
      return `WebFetch could not run its digest pass: ${message}`;
    case "invalid-request":
      return `WebFetch's digest pass was misconfigured: ${message}`;
    case "model-unresolvable":
      return `The digest model could not be resolved: ${message}`;
    case "no-credential":
      return `The digest model has no credential configured: ${message}`;
    case "provider-error":
      return `The digest model failed: ${message}`;
    case "aborted":
      return "WebFetch was interrupted before it could answer.";
  }
}

/**
 * Runs the digest pass and returns the final tool_result TEXT (never throws -- the spine's own
 * `runInnerModel` throw hazard, see the module header, is caught here regardless).
 */
async function runDigest(ctx: ToolExecutionContext, runtime: WebSessionRuntime, content: string, prompt: string, preapproved: boolean): Promise<{ output: string; isError: boolean }> {
  const guidelines = preapproved ? PERMISSIVE_GUIDELINES : STRICT_GUIDELINES;
  const built = digestPrompt(cappedForDigest(content), prompt, guidelines);
  const digestModel = runtime.web.fetch.digestModel;
  const model = digestModel !== undefined ? ({ kind: "tag" as const, tag: digestModel, ...(runtime.web.fetch.authRef !== undefined ? { authRef: runtime.web.fetch.authRef } : {}) }) : undefined;
  try {
    const result = await runInnerModel(ctx, { prompt: built, ...(model !== undefined ? { model } : {}) }, runtime);
    if (!result.ok) return { output: digestFailureMessage(result.code, result.message), isError: true };
    const text = result.text.trim();
    return { output: text.length > 0 ? result.text : "No response from model", isError: false };
  } catch (err) {
    // Defensive against the spine's own known throw hazard (see module header) -- NEVER the
    // message, which could carry resolver-internal detail (a probe upstream leaked a
    // secret-shaped one this way).
    return { output: `WebFetch's digest pass failed unexpectedly (${err instanceof Error ? err.name : "unknown error"}).`, isError: true };
  }
}

// --- the executor ----------------------------------------------------------------------------------

export interface WebFetchExecutorDeps {
  net?: WebFetchNetDeps;
  cache?: WebFetchCache;
  resolveHost?: (hostname: string) => Promise<readonly string[]>;
  now?: () => number;
}

export function createWebFetchExecutor(deps: WebFetchExecutorDeps = {}): ToolExecutor {
  const cache = deps.cache ?? webFetchCache;
  const resolveHost = deps.resolveHost ?? deps.net?.resolveHost ?? defaultResolveHost;
  const netDeps: WebFetchNetDeps = { ...deps.net, resolveHost };

  return {
    async execute(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
      const parsed = parseInput(rawInput);
      if ("error" in parsed) return { output: `Error: ${parsed.error}`, isError: true };
      const { prompt } = parsed;
      const inputUrlString = parsed.url;

      let originalUrl: URL;
      try {
        originalUrl = new URL(inputUrlString);
      } catch {
        return { output: invalidUrlMessage(inputUrlString), isError: true };
      }

      const runtime = webSessionRuntimeFor(ctx);
      if (runtime === undefined) {
        return { output: "WebFetch is not available in this session: no web session runtime is registered (a host wiring gap).", isError: true };
      }

      const brand = brandNameFor(ctx);
      const blockedDomains = runtime.web.blockedDomains;
      const policy = normalizePrivateAddressPolicy(runtime.web.fetch.privateAddressPolicy);

      if (isDomainBlocked(originalUrl.hostname, blockedDomains)) {
        return { output: `${brand} is unable to fetch from ${originalUrl.hostname}.`, isError: true };
      }

      const addressVerdict = await classifyHostname(originalUrl.hostname.replace(/^\[|\]$/g, ""), resolveHost);
      if (addressVerdict.class === "private") {
        if (policy === "deny") {
          return { output: `WebFetch will not reach ${originalUrl.hostname}: it is a private/loopback address, and this session's policy denies WebFetch access to private addresses.`, isError: true };
        }
        if (policy === "ask") {
          return {
            output: `WebFetch cannot prompt for approval mid-call. ${originalUrl.hostname} is a private/loopback address; the user must explicitly approve WebFetch(domain:${originalUrl.hostname}) before this URL can be fetched.`,
            isError: true,
          };
        }
        // "allow" falls through.
      }

      const preapproved = isPreapprovedUrl(originalUrl);

      let content: string;
      let contentType: string;
      let finalUrl: string;

      const cached = cache.get(ctx.sessionId, inputUrlString);
      if (cached !== undefined) {
        content = cached.content;
        contentType = cached.contentType;
        finalUrl = cached.finalUrl;
      } else {
        const outcome = await performWebFetch(inputUrlString, prompt, { blockedDomains, privateAddressPolicy: policy, userAgent: winterUserAgent(), ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) }, netDeps);
        switch (outcome.kind) {
          case "invalid-url":
            return { output: outcome.message, isError: true };
          case "blocked-domain":
            return { output: `${brand} is unable to fetch from ${outcome.host}.`, isError: true };
          case "private-address":
            return {
              output:
                outcome.policy === "deny"
                  ? `WebFetch will not reach ${outcome.host}: it is a private/loopback address, and this session's policy denies WebFetch access to private addresses.`
                  : `WebFetch cannot prompt for approval mid-call. ${outcome.host} is a private/loopback address; the user must explicitly approve WebFetch(domain:${outcome.host}) before this URL can be fetched.`,
              isError: true,
            };
          case "redirect-blocked":
            return { output: outcome.message, isError: false };
          case "too-many-redirects":
            return { output: outcome.message, isError: true };
          case "http-error": {
            const retryLine = outcome.retryAfter !== undefined ? `\nRetry-After: ${outcome.retryAfter}` : "";
            return {
              output: `The server returned HTTP ${outcome.status} ${outcome.statusText}.${retryLine}\n\nThe response body was not retrieved. If this URL requires authentication, use an authenticated tool (e.g. \`gh\` for GitHub, or an MCP-provided fetch tool) instead of WebFetch.`,
              isError: true,
            };
          }
          case "size-exceeded":
            return { output: outcome.message, isError: true };
          case "timeout":
            return { output: outcome.message, isError: true };
          case "aborted":
            return { output: "WebFetch was interrupted.", isError: true };
          case "network-error":
            return { output: `WebFetch could not reach the URL: ${outcome.message}`, isError: true };
          case "success":
            break;
        }
        // TypeScript can't see the exhaustive switch narrowed `outcome` to the success arm above.
        if (outcome.kind !== "success") throw new Error("unreachable");

        finalUrl = outcome.finalUrl;
        const kind = classifyContentType(outcome.contentType);
        if (kind === "html") {
          content = await convertFetchedHtml(new TextDecoder("utf-8", { fatal: false }).decode(outcome.body));
        } else if (kind === "text") {
          content = new TextDecoder("utf-8", { fatal: false }).decode(outcome.body);
        } else {
          const savedPath = await saveBinaryToTemp(ctx, originalUrl, outcome.body);
          const note =
            savedPath !== undefined
              ? `The fetched content is binary (content-type: ${outcome.contentType || "unknown"}, ${outcome.body.byteLength.toLocaleString("en-US")} bytes) and was saved to ${savedPath}. Binary content is not analyzed by WebFetch's digest model.`
              : `The fetched content is binary (content-type: ${outcome.contentType || "unknown"}, ${outcome.body.byteLength.toLocaleString("en-US")} bytes). Binary content was not retrieved: no session temp directory is available in this context.`;
          return { output: note };
        }
        contentType = outcome.contentType;

        const entry: WebFetchCacheEntry = { bytes: Buffer.byteLength(content, "utf8"), code: outcome.status, codeText: outcome.statusText, content, contentType, finalUrl };
        cache.set(ctx.sessionId, inputUrlString, entry);
      }

      // The preapproved verbatim passthrough: skip the digest model entirely.
      if (preapproved && contentType.toLowerCase().includes("text/markdown") && content.length < 100_000) {
        return { output: capResult(content) };
      }

      const digest = await runDigest(ctx, runtime, content, prompt, preapproved);
      return { output: capResult(digest.output), ...(digest.isError ? { isError: true } : {}) };
    },
  };
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  const results = await dnsLookup(hostname, { all: true });
  return results.map((r) => r.address);
}

replaceExecutor("WebFetch", createWebFetchExecutor());

// Exported for `web-fetch.test.ts` (verbatim-string pinning) without a second literal copy.
export { PERMISSIVE_GUIDELINES, STRICT_GUIDELINES };
export const WEB_FETCH_DEFAULT_TIMEOUT_MS = WEB_FETCH_TIMEOUT_MS;
