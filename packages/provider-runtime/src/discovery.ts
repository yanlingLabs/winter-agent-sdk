// Bounded, validated live model discovery. FROZEN as of P6 T2's merge (R6-12).
//
// WS-13 §7: the compiled catalog is a SEED, not a timeless list — a credential-scoped live catalog
// may add, remove, rename or restrict models. Discovery responses MUST be size-, time- and
// item-bounded and schema-validated; model IDs and names are UNTRUSTED display/input data;
// pagination, malformed items, duplicates, removals, partial catalogs and cached fallback are all
// tested behaviours.
//
// "Live facts never silently overwrite official-doc/live-probe overlay entries" is guaranteed
// STRUCTURALLY here rather than by discipline: this module has no reference to the catalog at all.
// It returns data; deciding what to do with it is the caller's, and merging into the overlay is
// Lane X's generator, offline, under review.
//
// The byte bound (`limits.maxBytes`) is enforced one layer down, by `boundedFetch` inside the
// adapter — that is where bytes actually exist. What this layer bounds is TIME, ITEM COUNT, and the
// shape and plausibility of every field that survives.

import type { DiscoveryContext, ModelCatalogResult, ProviderAdapter } from "./types.ts";
import { ProviderRequestError } from "./http.ts";

/** An id longer than this is not a model name; carrying it just moves a provider's problem into Winter's logs and paths. */
const MAX_MODEL_ID_CHARS = 256;
const MAX_DISPLAY_NAME_CHARS = 512;
/** Above this a "context window" is a parsing artifact, not a fact. */
const MAX_PLAUSIBLE_CONTEXT_WINDOW = 100_000_000;

export interface DiscoveryCache {
  get(key: string): ModelCatalogResult | undefined;
  set(key: string, value: ModelCatalogResult): void;
}

/** A plain in-memory cache. Process-lifetime, no expiry — the caller decides when a cache is stale by choosing whether to pass one. */
export function createDiscoveryCache(): DiscoveryCache {
  const entries = new Map<string, ModelCatalogResult>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => {
      entries.set(key, value);
    },
  };
}

/**
 * The cache key. Provider AND endpoint, because the same provider id behind two base URLs is two
 * different catalogs — a local gateway and a hosted one, or two Azure deployments. Keying on the
 * provider alone would serve one connection's inventory to another.
 *
 * Deliberately NOT keyed on the credential: a key would then have to be hashed into a cache key,
 * which is a credential going somewhere it does not need to go.
 */
function cacheKey(ctx: DiscoveryContext): string {
  // NUL as the separator, spelled `\u0000` rather than embedded as a raw byte: it cannot appear
  // in a provider id or a URL, so no two different connections can concatenate to the same key —
  // but a raw NUL in a source file makes git classify that file as BINARY, which silently erases
  // it from a diff and from a review package. Never write one literally.
  const SEP = "\u0000";
  return [ctx.connection.providerId, ctx.connection.baseUrl ?? "", ctx.connection.deployment ?? "", ctx.connection.region ?? "", ctx.connection.location ?? ""].join(SEP);
}

/** A model id must be printable, single-line and bounded — it reaches log lines, error text, and (as part of a qualified key) storage paths. */
function isUsableId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_MODEL_ID_CHARS) return false;
  // Control characters (a newline is a log-injection primitive; a NUL is a path primitive) and any
  // whitespace inside the id: no real model id contains either.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  if (/\s/.test(trimmed)) return false;
  return true;
}

function sanitizeDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, MAX_DISPLAY_NAME_CHARS);
}

function sanitizeContextWindow(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_PLAUSIBLE_CONTEXT_WINDOW) return undefined;
  return value;
}

function sanitizeModalities(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 64);
  return out.length > 0 ? out : undefined;
}

function abortError(): Error {
  const err = new Error("model discovery aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Runs `adapter.listModels` under the context's own bounds, validates and dedupes what comes back,
 * and falls back to a cached answer when the provider fails.
 *
 * A failure with NO cache entry PROPAGATES rather than returning an empty catalog: `{ models: [] }`
 * reads as "this provider has no models", which a picker would render as fact.
 */
export async function discoverModels(adapter: ProviderAdapter, ctx: DiscoveryContext, cache?: DiscoveryCache): Promise<ModelCatalogResult> {
  if (ctx.signal?.aborted === true) throw abortError();
  const key = cacheKey(ctx);

  let raw: ModelCatalogResult;
  try {
    // The timeout must CANCEL the adapter, not merely stop waiting for it. Racing a timer against a
    // bare promise leaves the underlying request running to completion in the background — holding a
    // socket, a body, and (on a hung provider) doing so for as long as the OS allows, while this
    // function has already reported a timeout. The controller composes our deadline WITH the
    // caller's own signal, so the adapter observes exactly one abort source.
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    ctx.signal?.addEventListener("abort", onCallerAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      raw = await Promise.race([
        adapter.listModels({ ...ctx, signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ProviderRequestError({ code: "timeout", message: `model discovery for "${ctx.connection.providerId}" exceeded ${ctx.limits.timeoutMs}ms`, retryable: true }));
          }, ctx.limits.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onCallerAbort);
    }
  } catch (err) {
    const cached = cache?.get(key);
    if (cached !== undefined) {
      // A cached answer is STALE by definition. Saying so is the difference between a graceful
      // degradation and a silent lie about what the provider currently offers.
      return {
        ...cached,
        cached: true,
        warnings: [...cached.warnings, `live discovery failed (${err instanceof Error ? err.message : String(err)}) — serving a cached catalog, which may be out of date`],
      };
    }
    throw err;
  }

  const warnings: string[] = [...(Array.isArray(raw.warnings) ? raw.warnings.filter((w): w is string => typeof w === "string") : [])];
  const models: ModelCatalogResult["models"] = [];
  const seen = new Set<string>();
  let dropped = 0;
  const incoming = Array.isArray(raw.models) ? raw.models : [];

  for (const item of incoming) {
    if (models.length >= ctx.limits.maxItems) break;
    if (item === null || typeof item !== "object") {
      dropped += 1;
      continue;
    }
    const candidate = item as { id?: unknown; displayName?: unknown; contextWindow?: unknown; inputModalities?: unknown };
    if (!isUsableId(candidate.id)) {
      dropped += 1;
      continue;
    }
    const id = candidate.id.trim();
    if (seen.has(id)) {
      warnings.push(`discovery returned a duplicate model id (${id}); the first occurrence was kept`);
      continue;
    }
    seen.add(id);
    const displayName = sanitizeDisplayName(candidate.displayName);
    const contextWindow = sanitizeContextWindow(candidate.contextWindow);
    const inputModalities = sanitizeModalities(candidate.inputModalities);
    models.push({
      id,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(inputModalities !== undefined ? { inputModalities } : {}),
    });
  }

  if (dropped > 0) {
    // ONE warning carrying the count, not one per drop. The per-drop version was unbounded: a
    // provider returning ten thousand malformed rows produced ten thousand identical strings, all of
    // which are retained in the cached result and re-emitted on every fallback. The count is the
    // whole of the information; repeating the sentence is not.
    warnings.push(`discovery dropped ${dropped} model row${dropped === 1 ? "" : "s"} with no usable id`);
  }
  if (models.length >= ctx.limits.maxItems && incoming.length > models.length) {
    warnings.push(`discovery returned more than the ${ctx.limits.maxItems}-model limit; the list was truncated and is PARTIAL`);
  }

  const result: ModelCatalogResult = {
    models,
    partial: raw.partial === true || (models.length >= ctx.limits.maxItems && incoming.length > models.length),
    cached: false,
    warnings,
  };
  cache?.set(key, result);
  ctx.log({ kind: "provider.discovery", providerId: ctx.connection.providerId });
  return result;
}
