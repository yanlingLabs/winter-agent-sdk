// "WebFetch" -- the REAL executor, replacing `descriptors/web-fetch.ts`'s stub.
//
// ORDER OF OPERATIONS (pinned so a reviewer can check this file against it in one pass):
//   parse input -> `new URL()` -> web session runtime wired? -> domain floor on the input host ->
//   cache lookup -> (HIT) private-address policy on the input host, gating whether the cached
//   content may be served -> (MISS) the local fetch, which re-applies the floor AND the
//   private-address policy on EVERY hop, INCLUDING hop 0 (`_web-fetch-net.ts`'s own loop; this is
//   why the miss path does not ALSO run the upfront private-address check here -- doing so would be
//   a second, redundant DNS resolution for the common case, see the "minor" note below) -> convert
//   (html/text/binary) -> preapproved verbatim passthrough, or the digest pass -> the registry's own
//   50,000-char result cap (this registry enforces none itself, so it is applied here).
//
// A FIX LANE IS REPAIRING A SPINE BUG IN PARALLEL (not edited here, per this lane's own scope):
//   `resolveWebToolsConfig` does not validate `privateAddressPolicy` at runtime (config arrives as
//   untyped JSON) -- `normalizePrivateAddressPolicy` below fails CLOSED: only the exact string
//   `"allow"` is treated as allow, `"deny"` is deny, everything else (including an unrecognised
//   value) behaves as `"ask"`. Disclosed in the report; the spine file is not touched here.
//
// SECURITY REVIEW FIX ROUND (2026-09-18):
//   B1 `execute()` itself now has a last-resort catch (below the main body) -- belt-and-braces over
//      `_web-fetch-net.ts`'s own fix, reporting the error's NAME only.
//   M5 a thrown `fetchImpl`'s `.message` (which can carry a proxy URL with embedded credentials --
//      measured) never reaches the result; `_web-fetch-net.ts` now relays `err.name` only, and THIS
//      file's own digest-failure mapping fixes the matching spine-adjacent leak: `runInnerModel`'s
//      `provider-error` code carries the underlying provider's `.message` (built by the SPINE's own
//      `_inner-model.ts`, not edited here) -- `digestFailureMessage` below maps that ONE code to a
//      fixed sentence instead of forwarding it, same as every other message on this file already is
//      Winter-authored rather than server- or provider-supplied.
//   Fidelity #2/#6/#10 (corrections §4 of the extraction notes): the `new URL()` parse-failure text
//      carries the `Error: ` prefix claude's own `validateInput` uses (the FETCH-TIME rejects, a
//      DIFFERENT bare `Invalid URL` text, live in `_web-fetch-net.ts`); the domain-block text has NO
//      trailing period; only `text/html` converts (not `application/xhtml+xml`, which is `text`).
//   Minor: the binary save now writes `0o600`/`flag:"wx"` and is bounded per session (a looping model
//      could otherwise fill the disk one 10 MB save at a time, with nothing ever deleting them).
import "../descriptors/web-fetch.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WINTER_BRAND, type WebPrivateAddressPolicy } from "@yanlinglabs/winter-agent-sdk";
import { winterUserAgent } from "@yanlinglabs/winter-provider-runtime";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { webSessionRuntimeFor, type WebSessionRuntime } from "../../web/session-runtime.ts";
import { isDomainBlocked } from "./_domains.ts";
import { classifyHostname, classifyHostnameLexically, stripIpv6Brackets, UNRESOLVABLE_HOST_REASON } from "../../web/private-address.ts";
import { isPreapprovedUrl } from "../../web/preapproved-hosts.ts";
import { convertFetchedHtml, WEB_FETCH_HTML_TRUNCATION_NOTICE } from "./_web-fetch-html.ts";
import { webFetchCache, WebFetchCache, type WebFetchCacheEntry } from "./_web-fetch-cache.ts";
import { defaultResolveHost, parseFailureMessage, performWebFetch, WEB_FETCH_TIMEOUT_MS, type NormalizedPrivateAddressPolicy, type WebFetchNetDeps } from "./_web-fetch-net.ts";
import { INNER_MODEL_BUDGET_EXCEEDED_DETAIL, runInnerModel, type InnerModelFailureCode } from "./_inner-model.ts";

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

/** Fails CLOSED (see the module header): only the exact string `"allow"` is treated as allow. */
function normalizePrivateAddressPolicy(policy: WebPrivateAddressPolicy | string | undefined): NormalizedPrivateAddressPolicy {
  if (policy === "allow") return "allow";
  if (policy === "deny") return "deny";
  return "ask";
}

function brandNameFor(ctx: ToolExecutionContext): string {
  return ctx.brand?.productName ?? WINTER_BRAND.productName;
}

/** Races `promise` against `signal` aborting; resolves `"aborted"` first if the signal wins. `signal` may be absent (a hand-built test context) -- then this is just `await promise`. */
async function raceAgainstAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | "aborted"> {
  if (signal === undefined) return promise;
  if (signal.aborted) return "aborted";
  return new Promise<T | "aborted">((resolve, reject) => {
    const onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function capResult(text: string): string {
  if (text.length <= RESULT_CAP) return text;
  return `${text.slice(0, RESULT_CAP)}\n\n[Result truncated at ${RESULT_CAP.toLocaleString("en-US")} characters.]`;
}

// --- content classification ---------------------------------------------------------------------------

type ContentKind = "html" | "text" | "binary";

/** Fidelity #10 (corrections §4.10): claude converts ONLY when the content type includes `text/html` -- NOT `application/xhtml+xml`, which this now falls through to the plain "text" branch as raw UTF-8. */
function classifyContentType(contentType: string): ContentKind {
  const ct = contentType.toLowerCase();
  if (ct.includes("text/html")) return "html";
  if (ct === "" || ct.startsWith("text/") || ct.includes("json") || ct.includes("xml") || ct.includes("javascript") || ct.includes("csv")) return "text";
  return "binary";
}

function sanitizeFilenameSegment(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return cleaned.length > 0 ? cleaned : "download";
}

// Security review minor: nothing ever deletes a saved binary (there is no session-end hook this lane
// can reach without editing the spine), so a looping model that keeps fetching binaries could
// otherwise fill the disk one save at a time. A per-session byte budget bounds it -- once exceeded,
// further binary content is reported as "not retrieved" rather than saved; existing files are left
// alone (this is a spend limit, not a cleanup mechanism). Mirrors the cache's own per-session/50 MiB
// shape for a consistent, already-reviewed number, though the two budgets are otherwise unrelated.
const BINARY_SAVE_BUDGET_BYTES = 50 * 1024 * 1024;
const binarySavedBytesBySession = new Map<string, number>();

// Item 1 fix: the budget must be RESERVED synchronously, before this function's first `await` --
// `writeFile`/`mkdir` yield to the event loop, and several concurrent calls each read `spent` before
// any of them had written it back (measured: 12 concurrent 10 MiB saves against this same 50 MiB
// budget landed 120 MiB on disk, because every one of the 12 read `spent === 0` before the first
// `await writeFile` let any of them update the map). Reserving here -- synchronous code, no `await`
// between the read and the write -- means the FIRST call past the budget line has already claimed
// its bytes before control ever returns to the event loop, so a concurrent sibling's own check sees
// the updated total. Rolled back in the `catch` below if the save itself then fails, so a failed
// write never permanently eats budget it never spent.
function reserveBinarySaveBudget(sessionId: string, bytes: number): boolean {
  const spent = binarySavedBytesBySession.get(sessionId) ?? 0;
  if (spent + bytes > BINARY_SAVE_BUDGET_BYTES) return false;
  binarySavedBytesBySession.set(sessionId, spent + bytes);
  return true;
}

function releaseBinarySaveBudget(sessionId: string, bytes: number): void {
  const spent = binarySavedBytesBySession.get(sessionId) ?? 0;
  binarySavedBytesBySession.set(sessionId, Math.max(0, spent - bytes));
}

async function saveBinaryToTemp(ctx: ToolExecutionContext, url: URL, bytes: Uint8Array): Promise<string | undefined | "budget-exceeded"> {
  if (typeof ctx.tempDir !== "string" || ctx.tempDir.length === 0) return undefined;
  if (!reserveBinarySaveBudget(ctx.sessionId, bytes.byteLength)) return "budget-exceeded";
  const lastSegment = url.pathname.split("/").filter((s) => s.length > 0).pop() ?? "download";
  const filename = `webfetch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${sanitizeFilenameSegment(lastSegment)}`;
  const path = join(ctx.tempDir, filename);
  try {
    await mkdir(ctx.tempDir, { recursive: true });
    // 0o600 (owner read/write only) and "wx" (fail rather than silently overwrite anything already
    // at this path -- the timestamp+random filename already makes a real collision astronomically
    // unlikely, this is defence in depth, not the primary uniqueness guarantee).
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    return path;
  } catch {
    releaseBinarySaveBudget(ctx.sessionId, bytes.byteLength);
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

// The inner-model helper reports a session-BUDGET stop as the `aborted` code with the detail
// `INNER_MODEL_BUDGET_EXCEEDED_DETAIL`, so its code union does not grow. Imported, never re-spelled:
// this file ALSO has an unrelated budget of its own (the saved-binary allowance, `saveBinaryToTemp`'s
// "budget-exceeded" return), and the two happen to share those words. They are different facts with
// different messages, and matching a literal here is how they would one day be conflated.

/** The digest pass was stopped because the session reached its spending limit -- NOT an interruption, and retrying cannot help. */
export const WEB_FETCH_BUDGET_STOP_MESSAGE =
  "WebFetch fetched the page but could not digest it: this session has reached its spending limit, so no further model calls can be made. Retrying will not help -- continue with the information already gathered, or ask the user to raise the session's budget.";

function digestFailureMessage(code: InnerModelFailureCode, message: string, detail?: string): string {
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
      // Security review finding M5: `message` here is built by the SPINE's own `_inner-model.ts`
      // from the underlying provider failure and can carry provider-internal detail (a probe found a
      // proxy URL with embedded credentials reaching this exact path). A FIXED sentence, never the
      // forwarded message -- every other string in this file is already Winter-authored rather than
      // server- or provider-supplied; this is the one place that rule had a gap.
      return "The digest model failed.";
    case "aborted":
      // TWO different things arrive under this one code. An interrupted turn is worth retrying; a
      // budget stop is not, and telling the model it "was interrupted" invites exactly the retry loop
      // the budget exists to end.
      return detail === INNER_MODEL_BUDGET_EXCEEDED_DETAIL ? WEB_FETCH_BUDGET_STOP_MESSAGE : "WebFetch was interrupted before it could answer.";
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
    if (!result.ok) return { output: digestFailureMessage(result.code, result.message, result.detail), isError: true };
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

  // THE `"ask"` POLICY, AND WHY IT IS DECIDED BEFORE THIS FILE EVER RUNS. An executor cannot prompt
  // mid-call. The ASK itself therefore happens in the permission layer, before execution: a call whose
  // url is private BY HOW IT IS WRITTEN (an IP literal in a private range, `localhost`, `.local`) is
  // put to the user -- or satisfied by an allow rule naming that exact host -- and the outcome arrives
  // here as `ctx.permission.explicitApproval`. This file's part is to HONOUR that marker and to keep
  // refusing without it.
  //
  //   marker      input host written as private?    a private target under "ask"
  //   ---------   ------------------------------    ------------------------------------------------
  //   "rule"      either                            PROCEEDS -- `WebFetch(domain:<host>)` is standing
  //                                                 consent for that host, wherever it resolves
  //   "prompt"    yes                               PROCEEDS -- the asker was told it is private
  //   "prompt"    no  (a public-looking name)       REFUSED  -- nobody was told; see below
  //   absent      either                            REFUSED  -- allowed by mode / a broad rule / a hook
  //
  // THE LATE CASE. A public-looking name that RESOLVES to a private address is only discoverable at
  // fetch time -- the permission layer does no DNS -- so no pre-execution ask could have mentioned it.
  // A user who approved "fetch intranet-looking.example" at an ordinary prompt did not knowingly
  // approve reaching 127.0.0.1 (that is what DNS rebinding looks like), so `"prompt"` does not cover
  // it. It stays refused, and the refusal names the one thing that does permit it: the allow rule
  // naming the host, which the next call then carries as `"rule"`.
  //
  // WHY "PROCEEDS" IS `"allow"` FOR THE WHOLE FETCH rather than for one hop: the fetch loop takes a
  // single policy, and it only ever auto-follows a redirect to the SAME host (modulo a leading
  // `www.`). A redirect to any OTHER host -- private or not -- is returned to the model as a redirect
  // message, and the model's re-call is a new call that goes back through the permission layer. So
  // "allow for this fetch" cannot reach a private host other than the one that was consented to.
  function effectivePolicyFor(policy: NormalizedPrivateAddressPolicy, inputHostname: string, ctx: ToolExecutionContext): NormalizedPrivateAddressPolicy {
    if (policy !== "ask") return policy; // "deny" is absolute; "allow" needs nothing
    const approval = ctx.permission?.explicitApproval;
    if (approval === "rule") return "allow";
    if (approval === "prompt" && classifyHostnameLexically(inputHostname)?.class === "private") return "allow";
    return "ask";
  }

  /**
   * `unresolvedReason` is item 2: a cache-HIT lookup (the only caller that ever passes it -- the
   * MISS path's own `private-address` outcome is never a resolution failure, see `_web-fetch-net.ts`,
   * which reports that case as `network-error` instead) can fail closed with `class: "private"` for
   * a reason that is NOT "this address is private" -- it is "nothing is known about this address".
   * The two used to share one refusal text ("it is a private/loopback address," which is simply
   * false when resolution just failed), so this checks the reason FIRST, before either policy
   * branch, and matches the MISS path's own exact wording for the same fact
   * (`WebFetch could not resolve any address for <host>.`) so the two paths never diverge.
   */
  function privateAddressRefusal(host: string, policy: NormalizedPrivateAddressPolicy, unresolvedReason?: string): ToolResultPayload | undefined {
    if (unresolvedReason === UNRESOLVABLE_HOST_REASON) {
      if (policy === "allow") return undefined; // an explicit allow needs no resolution to proceed
      return { output: `WebFetch could not resolve any address for ${host}.`, isError: true };
    }
    if (policy === "deny") {
      return { output: `WebFetch will not reach ${host}: it is a private/loopback address, and this session's policy denies WebFetch access to private addresses.`, isError: true };
    }
    if (policy === "ask") {
      if (classifyHostnameLexically(host)?.class !== "private") {
        // The late case: private by RESOLUTION only.
        return {
          output: `WebFetch will not reach ${host}: it resolves to a private/loopback address. That is only discoverable at fetch time, so no approval could be asked for it beforehand, and WebFetch cannot prompt for approval mid-call. An allow rule naming the host permits it: WebFetch(domain:${host}).`,
          isError: true,
        };
      }
      return { output: `WebFetch cannot prompt for approval mid-call. ${host} is a private/loopback address; the user must explicitly approve WebFetch(domain:${host}) before this URL can be fetched.`, isError: true };
    }
    return undefined; // "allow"
  }

  async function executeInner(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    const parsed = parseInput(rawInput);
    if ("error" in parsed) return { output: `Error: ${parsed.error}`, isError: true };
    const { prompt } = parsed;
    const inputUrlString = parsed.url;

    let originalUrl: URL;
    try {
      originalUrl = new URL(inputUrlString);
    } catch {
      return { output: parseFailureMessage(inputUrlString), isError: true };
    }

    const runtime = webSessionRuntimeFor(ctx);
    if (runtime === undefined) {
      return { output: "WebFetch is not available in this session: no web session runtime is registered (a host wiring gap).", isError: true };
    }

    const brand = brandNameFor(ctx);
    const blockedDomains = runtime.web.blockedDomains;
    const policy = effectivePolicyFor(normalizePrivateAddressPolicy(runtime.web.fetch.privateAddressPolicy), originalUrl.hostname, ctx);

    // Fidelity #6 (corrections §4.6): no trailing period -- claude's own `Claude Code is unable to
    // fetch from ${host}` has none, measured directly in the binary.
    if (isDomainBlocked(originalUrl.hostname, blockedDomains)) {
      return { output: `${brand} is unable to fetch from ${originalUrl.hostname}`, isError: true };
    }

    const preapproved = isPreapprovedUrl(originalUrl);

    let content: string;
    let contentType: string;

    const cached = cache.get(ctx.sessionId, inputUrlString);
    if (cached !== undefined) {
      // The private-address check runs HERE, on a cache HIT only: `performWebFetch` already runs it
      // (and pins the connection to what it resolves, see `_web-fetch-net.ts`'s own M6 fix) for every
      // fresh fetch, including hop 0 -- checking it again unconditionally here would be a second,
      // redundant DNS resolution on the common (miss) path for a decision the fetch loop already
      // makes correctly. A HIT never touches the network at all, so it is the one path that needs its
      // own check: the host's policy can change between when a URL was cached and when it is served
      // again, and a cached response must not silently bypass a floor or policy now in effect.
      // Security review minor: this lookup was not previously raced against the turn's own signal
      // (a DNS resolver that never answers could hold a cache-hit call open indefinitely, outside
      // WebFetch's own 60 s fetch timeout entirely, since a hit never reaches the fetch loop at all).
      const addressVerdict = await raceAgainstAbort(classifyHostname(stripIpv6Brackets(originalUrl.hostname), resolveHost), ctx.signal);
      if (addressVerdict === "aborted") return { output: "WebFetch was interrupted.", isError: true };
      if (addressVerdict.class === "private") {
        const refusal = privateAddressRefusal(originalUrl.hostname, policy, addressVerdict.reason);
        if (refusal !== undefined) return refusal;
      }
      content = cached.content;
      contentType = cached.contentType;
    } else {
      const outcome = await performWebFetch(inputUrlString, prompt, { blockedDomains, privateAddressPolicy: policy, userAgent: winterUserAgent(), ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) }, netDeps);
      switch (outcome.kind) {
        case "invalid-url":
          return { output: outcome.message, isError: true };
        case "blocked-domain":
          return { output: `${brand} is unable to fetch from ${outcome.host}`, isError: true };
        case "private-address": {
          const refusal = privateAddressRefusal(outcome.host, outcome.policy);
          return refusal ?? { output: `WebFetch refused ${outcome.host}.`, isError: true }; // unreachable in practice: `outcome.policy` is always deny/ask
        }
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
        default: {
          // Exhaustiveness belt-and-braces (security review finding B1): a future outcome kind this
          // switch has not been taught about is a RESULT, never a throw that would end the turn.
          const unhandled: never = outcome;
          return { output: `WebFetch produced an unrecognised outcome (${(unhandled as { kind: string }).kind}).`, isError: true };
        }
      }
      if (outcome.kind !== "success") {
        return { output: "WebFetch produced no result.", isError: true }; // structurally unreachable; never a throw
      }

      const kind = classifyContentType(outcome.contentType);
      if (kind === "html") {
        content = await convertFetchedHtml(new TextDecoder("utf-8", { fatal: false }).decode(outcome.body));
      } else if (kind === "text") {
        content = new TextDecoder("utf-8", { fatal: false }).decode(outcome.body);
      } else {
        const savedPath = await saveBinaryToTemp(ctx, originalUrl, outcome.body);
        const sizeLabel = `${outcome.body.byteLength.toLocaleString("en-US")} bytes`;
        const note =
          savedPath === "budget-exceeded"
            ? `The fetched content is binary (content-type: ${outcome.contentType || "unknown"}, ${sizeLabel}). Binary content was not retrieved: this session's binary-save budget (${(BINARY_SAVE_BUDGET_BYTES / (1024 * 1024)).toFixed(0)} MiB) has been reached.`
            : savedPath !== undefined
              ? `The fetched content is binary (content-type: ${outcome.contentType || "unknown"}, ${sizeLabel}) and was saved to ${savedPath}. Binary content is not analyzed by WebFetch's digest model.`
              : `The fetched content is binary (content-type: ${outcome.contentType || "unknown"}, ${sizeLabel}). Binary content was not retrieved: no session temp directory is available in this context.`;
        return { output: note };
      }
      contentType = outcome.contentType;

      // Binary responses are never cached (deliberate deviation, see the report): the "saved to"
      // note names an ephemeral temp path that may not outlive the session incarnation that made it,
      // so re-serving it from cache on a later call could point at a file that is already gone.
      const entry: WebFetchCacheEntry = { bytes: Buffer.byteLength(content, "utf8"), code: outcome.status, codeText: outcome.statusText, content, contentType, finalUrl: outcome.finalUrl };
      cache.set(ctx.sessionId, inputUrlString, entry);
    }

    // The preapproved verbatim passthrough: skip the digest model entirely.
    if (preapproved && contentType.toLowerCase().includes("text/markdown") && content.length < 100_000) {
      return { output: capResult(content) };
    }

    const digest = await runDigest(ctx, runtime, content, prompt, preapproved);
    return { output: capResult(digest.output), ...(digest.isError ? { isError: true } : {}) };
  }

  return {
    async execute(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
      // Security review finding B1: a last-resort catch over the WHOLE executor. `_web-fetch-net.ts`
      // now catches its own body-phase failures, but this is belt-and-braces against anything this
      // file's own conversion/digest/cache code might someday throw -- an executor must NEVER end the
      // user's turn. The error's NAME only (finding M5's own rule, applied uniformly): a message could
      // carry anything a lower layer's own exception happened to be carrying.
      try {
        return await executeInner(rawInput, ctx);
      } catch (err) {
        return { output: `WebFetch failed unexpectedly (${err instanceof Error ? err.name : "unknown error"}).`, isError: true };
      }
    },
  };
}

replaceExecutor("WebFetch", createWebFetchExecutor());

// Exported for `web-fetch.test.ts` (verbatim-string pinning) without a second literal copy.
export { PERMISSIVE_GUIDELINES, STRICT_GUIDELINES };
export const WEB_FETCH_DEFAULT_TIMEOUT_MS = WEB_FETCH_TIMEOUT_MS;

// Exported for web-fetch.test.ts's own item-1 concurrency proof: calling `saveBinaryToTemp` directly,
// back-to-back with no `await` between calls, is the only way to pin the reservation race
// deterministically -- going through the whole network stack lets real I/O jitter dilute the timing
// the race depends on.
export { saveBinaryToTemp, BINARY_SAVE_BUDGET_BYTES };
